package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shaq/webhook-platform/services/data-plane/internal/egress"
	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
	"github.com/shaq/webhook-platform/services/data-plane/internal/signing"
)

// deferBaseDelay is how long a delivery waits after being turned away by a
// concurrency ceiling. Short, because the ceiling is a momentary condition and
// the work is genuinely ready; jittered, because a hundred deliveries deferred
// together must not return together.
const deferBaseDelay = 2 * time.Second

// handle runs one leased delivery end to end. It never returns an error: every
// outcome is either persisted or deliberately abandoned, and a caller that
// could only log it would add nothing.
func (w *Worker) handle(ctx context.Context, lease queue.Lease) {
	job := lease.Job
	log := w.log.With(
		"delivery_id", job.DeliveryID,
		"event_id", job.EventID,
		"endpoint_id", job.EndpointID,
		"project_id", job.ProjectID,
		"attempt", job.Attempt+1,
	)

	// Tenant ceilings first, before any database work: a delivery that cannot
	// run should cost one UPDATE, not a join and a decrypt.
	releaseTenant, scope, ok := w.gate.AcquireTenant(job.OrganizationID, job.ProjectID)
	if !ok {
		metrics.RateLimitHits.WithLabelValues(scope).Inc()
		// unknownBudget: the row has not been read yet, so there is no policy to
		// judge against. Deliberate - a tenant concurrency ceiling is a
		// momentary condition that clears on its own, not a state a delivery can
		// be stuck in indefinitely, and reading the row here would put a join
		// and a decrypt in front of every refusal.
		w.deferDelivery(ctx, job.DeliveryID, unknownBudget, ReasonConcurrencyLimited,
			w.spread(deferBaseDelay), log, slog.String("scope", scope))
		return
	}
	defer releaseTenant()

	// From here on the attempt runs under the lease keeper's context. If the
	// lease is lost the context is cancelled with cause queue.ErrLeaseLost, the
	// HTTP request aborts wherever it is, and nothing is written.
	attemptCtx, doneTracking := w.keeper.Track(ctx, job.DeliveryID)
	defer doneTracking()

	metrics.WorkersActive.Inc()
	defer metrics.WorkersActive.Dec()

	w.deliver(attemptCtx, job, log)
}

func (w *Worker) deliver(ctx context.Context, j queue.DeliveryJob, log *slog.Logger) {
	loadCtx, cancelLoad := w.dbContext(ctx)
	job, err := w.store.Load(loadCtx, j.DeliveryID)
	cancelLoad()
	if err != nil {
		if errors.Is(err, ErrDeliveryGone) {
			// The row is gone (a hard delete, or a replay that superseded it).
			// There is nothing to record an attempt against and nothing to
			// release; the lease dies with the row.
			log.Warn("claimed delivery no longer exists", "reason", "row disappeared between claim and load")
			return
		}
		// A transient database fault. Push the delivery out rather than
		// spinning on it: without a delay the next poll re-claims it
		// immediately and a database blip becomes a hot loop.
		log.Error("load delivery failed", "error", err)
		// unknownBudget for the same reason as above, and a sharper one: the
		// read that would tell us the budget is the read that just failed.
		w.deferDelivery(ctx, j.DeliveryID, unknownBudget, ReasonRetryScheduled,
			w.spread(deferBaseDelay), log)
		return
	}
	log = log.With("endpoint_url_host", hostOf(job.Endpoint.URL))

	if deliverable, reason := job.Endpoint.Deliverable(); !deliverable {
		// Not a failure of this delivery - the operator switched the endpoint
		// off. Cancelled is the state that says "we stopped on purpose", and
		// it keeps `failed` meaning "the endpoint rejected it".
		w.finish(ctx, job, nil, Decision{State: StateCancelled, Reason: reason}, log)
		return
	}

	releaseEndpoint, ok := w.gate.AcquireEndpoint(job.Endpoint.ID, job.Endpoint.MaxConcurrency, w.endpointCeiling)
	if !ok {
		metrics.RateLimitHits.WithLabelValues("endpoint_concurrency").Inc()
		w.deferDelivery(ctx, job.DeliveryID, budgetOf(job), ReasonConcurrencyLimited,
			w.spread(deferBaseDelay), log)
		return
	}
	defer releaseEndpoint()

	// The endpoint's own rate limit is checked HERE: after the cheap
	// concurrency gate, and before both the payload fetch and the breaker.
	//
	// It used to sit between the breaker and the request, and that was a bug
	// rather than an ordering preference. breaker.Allow CLAIMS the half-open
	// probe slot, so a recovering endpoint that also had endpoints.rate_limit
	// set could have its one probe consumed by a delivery that then deferred
	// here and never reached the network - delaying recovery by a whole
	// HalfOpenTTL each time, indefinitely if the bucket stayed saturated. The
	// rule the comment below states for the payload fetch applies to every
	// gate: nothing that can defer may sit between claiming the probe and
	// making the request.
	if job.Endpoint.RateLimit > 0 {
		allowed, wait := w.limiter.Allow(ctx, "endpoint:"+job.Endpoint.ID,
			job.Endpoint.RateLimit, job.Endpoint.RateLimitWindow)
		if !allowed {
			metrics.RateLimitHits.WithLabelValues("endpoint").Inc()
			w.deferDelivery(ctx, job.DeliveryID, budgetOf(job), ReasonRateLimited, w.spread(wait), log)
			return
		}
	}

	// Resolve the payload HERE, after both cheap gates and before the breaker,
	// and the position is deliberate on both sides.
	//
	// After the gates, because an object storage fetch for a delivery that a
	// concurrency ceiling or a rate limit is about to turn away is wasted
	// bandwidth on the one path that is already saturated.
	//
	// Before the breaker, because Allow CLAIMS the half-open probe slot for a
	// recovering endpoint. Claiming that slot and then deferring because OUR
	// bucket is down would spend a recovering endpoint's one probe on a
	// delivery that never reaches the network, and delay its recovery by a
	// whole cooldown for a reason that has nothing to do with it.
	payload, err := w.resolvePayload(ctx, job)
	if err != nil {
		if errors.Is(err, ErrPayloadStoreUnavailable) {
			// The endpoint is fine; we are not. Defer WITHOUT recording an
			// attempt: no request was made, so nothing may be charged against
			// the retry budget, and the delivery drains on its own once the
			// bucket comes back.
			log.Error("payload could not be fetched from object storage; deferring", "error", err)
			w.deferDelivery(ctx, job.DeliveryID, budgetOf(job), ReasonPayloadUnavailable,
				w.spread(deferBaseDelay), log)
			return
		}
		// ErrPayloadGone / ErrPayloadCorrupt / ErrNoPayload: definitive, and
		// recorded as an attempt so the ledger can answer for it.
		w.recordNonHTTP(ctx, job, w.now(), err, log)
		return
	}
	// From here the delivery signs and sends exactly these bytes and nothing
	// derived from them.
	job.Payload = payload

	breakerCtx, cancelBreaker := w.dbContext(ctx)
	verdict := w.breaker.Allow(breakerCtx, job.Endpoint.ID)
	cancelBreaker()
	if !verdict.Allowed {
		metrics.RateLimitHits.WithLabelValues("circuit_breaker").Inc()
		delay := verdict.RetryAfter.Sub(w.now())
		if delay < time.Second {
			delay = time.Second
		}
		w.deferDelivery(ctx, job.DeliveryID, budgetOf(job), verdict.Reason, delay, log,
			slog.String("breaker_state", string(verdict.State)))
		return
	}

	// From here to w.client.Do, nothing may defer for a reason attributable to
	// the ENDPOINT or to this platform's load: the probe slot is already
	// claimed, and spending it on a request that is never made costs the
	// endpoint a whole cooldown of recovery. That is why the rate-limit and
	// payload-fetch gates sit above breaker.Allow rather than here.
	//
	// The one exemption is worker shutdown (attempt() checks it before the
	// request), and it costs nothing: on an already-cancelled context
	// w.client.Do returns immediately and lands in the identical shutdown defer
	// on the far side, so the probe is spent either way. The early check only
	// saves a futile syscall.
	w.attempt(ctx, job, verdict, log)
}

// attempt performs the one thing that cannot be undone: the HTTP request.
func (w *Worker) attempt(ctx context.Context, job *Job, verdict Verdict, log *slog.Logger) {
	started := w.now()
	timestamp := started.Truncate(time.Second)

	// Signing comes before the request and fails CLOSED. An endpoint with no
	// usable secret does not get an unsigned delivery; it gets a recorded,
	// retryable failure that an operator can see.
	signature, err := w.sign(job, timestamp, log)
	if err != nil {
		w.recordNonHTTP(ctx, job, started, err, log)
		return
	}
	if len(job.Payload) == 0 {
		// Unreachable: resolvePayload has already established the bytes and
		// verified them against events.payload_hash. Kept because the cost of
		// being wrong is signing and shipping an empty body - see ErrNoPayload.
		w.recordNonHTTP(ctx, job, started,
			fmt.Errorf("%w (payload_location=%q)", ErrNoPayload, job.PayloadLocation), log)
		return
	}

	headers := BuildHeaders(HeaderInput{
		EventID:    job.EventID,
		DeliveryID: job.DeliveryID,
		EventType:  job.EventType,
		Attempt:    job.AttemptNumber,
		Timestamp:  timestamp,
		Signature:  signature,
		Custom:     job.Endpoint.CustomHeaders,
	})

	// One last check before the irreversible part. It narrows - it cannot
	// close - the window in which a lease is lost between the breaker check and
	// the request, and every request avoided here is a duplicate the customer
	// does not receive.
	if errors.Is(context.Cause(ctx), queue.ErrLeaseLost) {
		metrics.LeasesLost.WithLabelValues("attempt").Inc()
		return
	}
	// And the same for our own shutdown. The drain window has closed, so this
	// request would be cancelled the moment it started; sending it anyway costs
	// the endpoint a duplicate and costs the delivery an attempt.
	if errors.Is(context.Cause(ctx), ErrWorkerShutdown) {
		w.deferDelivery(ctx, job.DeliveryID, budgetOf(job), ReasonWorkerShutdown,
			w.spread(deferBaseDelay), log)
		return
	}

	// endpoints.timeout_ms can only SHORTEN the attempt: the egress client
	// applies EGRESS_TOTAL_TIMEOUT_MS of its own, and letting a customer's
	// column extend the platform's ceiling would hand any endpoint the ability
	// to hold a worker slot for as long as it liked.
	callCtx := ctx
	if job.Endpoint.Timeout > 0 {
		var cancelCall context.CancelFunc
		callCtx, cancelCall = context.WithTimeout(ctx, job.Endpoint.Timeout)
		defer cancelCall()
	}

	resp, doErr := w.client.Do(callCtx, http.MethodPost, job.Endpoint.URL, headers, job.Payload)
	finished := w.now()

	// THE crash-safety check, and it must come before any write.
	//
	// If the lease was lost while this request was in flight, another worker
	// owns the delivery now and may already have delivered it. Writing an
	// attempt row or a status transition here is how one webhook ends up with
	// two terminal statuses decided by whichever process committed last.
	if errors.Is(context.Cause(ctx), queue.ErrLeaseLost) {
		metrics.LeasesLost.WithLabelValues("attempt").Inc()
		log.Warn("lease lost during attempt; discarding its result",
			"reason", "another worker owns this delivery; recording it would duplicate the ledger")
		return
	}

	// The OTHER reason this request may have died with nothing to show for it:
	// we cancelled it. A graceful shutdown whose drain window expired must not
	// be recorded as the endpoint failing to answer - that writes `context
	// canceled` into the customer's ledger, advances attempt_count, and moves
	// their circuit breaker one failure closer to open, for a restart of ours.
	//
	// Only when the request actually failed. A response that arrived before the
	// cancellation landed is a real outcome and is recorded as one; throwing it
	// away would guarantee the duplicate that deferring only risks.
	if doErr != nil && errors.Is(context.Cause(ctx), ErrWorkerShutdown) {
		log.Warn("attempt cancelled by worker shutdown; putting the delivery back unattempted",
			"reason", "our drain window closed, so this is not the endpoint's failure and is not charged to it")
		w.deferDelivery(ctx, job.DeliveryID, budgetOf(job), ReasonWorkerShutdown,
			w.spread(deferBaseDelay), log)
		return
	}

	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	outcome := Outcome{HTTPStatus: status, Err: doErr}
	if resp != nil {
		// The endpoint's own answer to "when should we come back". Parsed here
		// rather than in Decide so the state machine stays free of HTTP.
		if wait, ok := ParseRetryAfter(resp.Headers.Get("Retry-After"), finished); ok {
			outcome.RetryAfter, outcome.HasRetryAfter = wait, true
		}
	}
	decision := w.rng.decide(DecisionInput{
		Attempt:        job.AttemptNumber,
		Policy:         job.Policy,
		FirstAttemptAt: job.FirstAttemptAt,
		Now:            finished,
		Outcome:        outcome,
	})

	attempt := &AttemptRecord{
		Number:         job.AttemptNumber,
		StartedAt:      started,
		CompletedAt:    finished,
		Status:         decision.AttemptStatus,
		HTTPStatus:     status,
		RequestHeaders: RedactHeaders(headers),
		ErrorCode:      decision.ErrorCode,
		Duration:       finished.Sub(started),
		WorkerID:       w.workerID,
	}
	if resp != nil {
		attempt.ResponseHeaders = RedactHeaders(resp.Headers)
		attempt.ResponseBody = w.storableBody(resp)
		attempt.ResponseSize = len(resp.Body)
	}
	if doErr != nil {
		attempt.ErrorMessage = truncate(doErr.Error(), 1024)
	}

	metrics.AttemptLatency.WithLabelValues(string(decision.AttemptStatus)).Observe(attempt.Duration.Seconds())
	metrics.HTTPResponses.WithLabelValues(StatusClass(status, doErr)).Inc()

	w.recordHealth(ctx, job.Endpoint.ID, status, doErr, verdict, log)
	w.finish(ctx, job, attempt, decision, log)
}

// sign builds the Webhook-Signature header from every currently-active secret,
// so a rotation window emits one v1= per secret and a consumer holding either
// one verifies (ARCHITECTURE.md 28).
func (w *Worker) sign(job *Job, ts time.Time, log *slog.Logger) (string, error) {
	plaintexts := make([]string, 0, len(job.Secrets))
	for _, sec := range job.Secrets {
		plaintext, err := w.keyring.Decrypt(sec.Envelope, SecretContext(sec.ID, job.Endpoint.ID))
		if err != nil {
			// Loud, and then carry on with the secrets that DID open. A
			// ciphertext that fails to authenticate is either a key missing
			// from this process's ring or a row that has been moved or
			// re-pointed - and in the second case refusing to use the OTHER,
			// legitimate secrets would hand an attacker with database write
			// access a denial of service on the endpoint.
			log.Error("endpoint secret could not be decrypted",
				"secret_id", sec.ID, "secret_version", sec.Version, "error", err,
				"reason", "wrong key id, or the row was moved to another endpoint")
			continue
		}
		plaintexts = append(plaintexts, plaintext)
	}

	header, err := signing.Header(plaintexts, job.Payload, ts)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrSigning, err)
	}
	return header, nil
}

// recordNonHTTP records an attempt that never reached the network - it could
// not be signed, or there were no payload bytes to send.
//
// It still writes an attempt row. The ledger is meant to answer "what happened
// to this event", and "we tried and could not sign it" is an answer; a gap in
// the attempt numbers is not.
func (w *Worker) recordNonHTTP(ctx context.Context, job *Job, started time.Time, cause error, log *slog.Logger) {
	if errors.Is(context.Cause(ctx), queue.ErrLeaseLost) {
		metrics.LeasesLost.WithLabelValues("attempt").Inc()
		return
	}
	now := w.now()
	decision := w.rng.decide(DecisionInput{
		Attempt:        job.AttemptNumber,
		Policy:         job.Policy,
		FirstAttemptAt: job.FirstAttemptAt,
		Now:            now,
		Outcome:        Outcome{Err: cause},
	})
	if errors.Is(cause, ErrSigning) {
		decision.Reason = ReasonSigningFailed
	}
	if errors.Is(cause, ErrNoPayload) {
		decision.Reason = ReasonPayloadUnavailable
	}
	if errors.Is(cause, ErrPayloadGone) {
		decision.Reason = ReasonPayloadGone
	}
	if errors.Is(cause, ErrPayloadCorrupt) {
		decision.Reason = ReasonPayloadCorrupt
	}

	log.Error("delivery could not be attempted", "error", cause, "next_state", string(decision.State))
	metrics.AttemptLatency.WithLabelValues(string(decision.AttemptStatus)).Observe(0)

	w.finish(ctx, job, &AttemptRecord{
		Number:       job.AttemptNumber,
		StartedAt:    started,
		CompletedAt:  now,
		Status:       AttemptError,
		ErrorCode:    decision.ErrorCode,
		ErrorMessage: truncate(cause.Error(), 1024),
		WorkerID:     w.workerID,
	}, decision, log)
}

// recordHealth feeds the circuit breaker.
//
// What counts as a breaker failure is narrower than what counts as a delivery
// failure, and the difference matters: a 400 means the endpoint is up and
// answering, so opening the breaker on it would remove delivery pressure from a
// perfectly healthy endpoint that simply dislikes one payload. Only the
// signals that mean "this endpoint cannot take traffic right now" - transport
// errors, timeouts, 408, 429, 5xx - count against it.
func (w *Worker) recordHealth(ctx context.Context, endpointID string, status int, err error, verdict Verdict, log *slog.Logger) {
	if retry.IsBlockedTarget(err) {
		// Our own egress policy refused to dial. That says nothing about the
		// endpoint's health and must not open its breaker.
		return
	}
	success := !retry.ShouldRetry(status, err)
	if err == nil && status >= 200 && status <= 299 {
		success = true
	}

	healthCtx, cancel := w.dbContext(ctx)
	defer cancel()
	if _, err := w.breaker.RecordOutcome(healthCtx, endpointID, success); err != nil {
		// Best effort on purpose: breaker bookkeeping must never turn a
		// successful delivery into a failed one.
		log.Warn("circuit breaker bookkeeping failed", "error", err, "probe", verdict.Probe)
	}
}

// finish persists the attempt and the transition, then emits the metrics.
func (w *Worker) finish(ctx context.Context, job *Job, attempt *AttemptRecord, decision Decision, log *slog.Logger) {
	next := Transition{State: decision.State, Reason: decision.Reason}
	if attempt != nil {
		next.AttemptCount = attempt.Number
	}
	if !decision.NextAttemptAt.IsZero() {
		next.Delay = decision.NextAttemptAt.Sub(w.now())
	}

	// Detached from cancellation, bounded by a timeout. A SIGTERM that arrives
	// between the HTTP response and this write must not lose the attempt
	// record: the endpoint has already received the webhook, and a delivery
	// whose ledger does not say so is one an operator cannot answer questions
	// about. Lease loss is checked before we get here, so this write is still
	// guarded by locked_by and cannot clobber another worker's claim.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), w.dbTimeout)
	defer cancel()

	if err := w.store.Complete(writeCtx, w.workerID, job.DeliveryID, attempt, next); err != nil {
		if errors.Is(err, ErrLeaseNotHeld) {
			metrics.LeasesLost.WithLabelValues("complete").Inc()
			log.Warn("delivery was reclaimed before its result could be recorded",
				"state", string(decision.State),
				"reason", "another worker owns it; at-least-once means the endpoint may see this delivery twice")
			return
		}
		log.Error("record delivery result failed",
			"error", err, "state", string(decision.State), "reason", string(decision.Reason))
		return
	}

	switch decision.State {
	case StateSucceeded:
		metrics.DeliveriesCompleted.WithLabelValues("succeeded").Inc()
		if !job.EventCreatedAt.IsZero() {
			metrics.DeliveryLatency.Observe(w.now().Sub(job.EventCreatedAt).Seconds())
		}
		log.Info("delivery succeeded",
			"http_status", attemptStatusCode(attempt), "duration_ms", attemptDurationMS(attempt))
	case StateRetrying:
		metrics.DeliveriesRetried.Inc()
		log.Warn("delivery scheduled for retry",
			"http_status", attemptStatusCode(attempt),
			"error_code", decision.ErrorCode,
			"retry_in", next.Delay.String(),
			// Which schedule produced retry_in. Without it an operator staring
			// at a 3600s gap under a 60s policy has no way to tell an honoured
			// Retry-After from a broken backoff calculation.
			"retry_after_honoured", decision.RetryAfterHonoured,
			"reason", string(decision.Reason))
	default:
		metrics.DeliveriesCompleted.WithLabelValues(string(decision.State)).Inc()
		log.Warn("delivery reached a terminal state",
			"state", string(decision.State),
			"reason", string(decision.Reason),
			"http_status", attemptStatusCode(attempt),
			"error_code", decision.ErrorCode)
	}
}

// deferBudget is the wall-clock half of a delivery's retry budget, carried into
// deferDelivery so that a delivery which is only ever DEFERRED can still end.
//
// The zero value means "not known here" - see unknownBudget.
type deferBudget struct {
	policy         retry.Policy
	firstAttemptAt time.Time
}

// budgetOf reads the budget off a loaded delivery.
func budgetOf(job *Job) deferBudget {
	return deferBudget{policy: job.Policy, firstAttemptAt: job.FirstAttemptAt}
}

// unknownBudget is used by the two defer paths that run before the delivery row
// has been read: the tenant concurrency gate (which runs before any database
// work by design) and the load failure itself. Neither can be stuck forever -
// a tenant ceiling clears as work drains, and a database that never answers is
// not a state in which anything is being delivered - so neither is worth
// putting a query in front of.
var unknownBudget = deferBudget{}

// expired reports whether the delivery's wall-clock budget has run out.
func (b deferBudget) expired(now time.Time) bool {
	return b.policy.DurationExhausted(b.firstAttemptAt, now)
}

// deferDelivery puts a delivery back WITHOUT recording an attempt, because
// none was made. The retry budget is for endpoints that answered badly, not for
// moments when this process declined to ask.
//
// The reason is written to deliveries.last_error as well as the log. That
// column is the only free-text field the operator UI has, and "why is this
// delivery not moving" is the question it exists to answer; the alternative is
// a delivery sitting in `scheduled` with no explanation anywhere a human looks.
//
// WHY THE BUDGET CHECK LIVES HERE rather than at the call sites. The two halves
// of the retry budget are spent by different things, and a defer spends exactly
// one of them:
//
//   - attempt_count is spent by a REQUEST. A defer makes none, so it charges
//     none. That is deliberate and is preserved: this function never writes a
//     positive AttemptCount.
//   - MaxRetryDuration is spent by the CLOCK, which runs whether or not we
//     asked. A delivery that is deferred and re-claimed forever is a delivery
//     whose wall-clock budget is running down with nothing ever consulting it.
//
// retry.Policy.Exhausted was reachable from exactly one place - Decide, on a
// COMPLETED attempt - so a delivery behind a permanently open breaker never
// reached any budget check at all. It was re-claimed every cooldown forever,
// and under the default FIFO claim (a strict global ordering, no tenant
// predicate) those ever-older rows sort AHEAD of live traffic: one dead
// endpoint degrades the whole queue. There is no reaper in either plane to
// catch it later.
//
// Putting the check in this function rather than at each `if !ok` means a
// future defer path cannot forget it - the budget is a parameter it has to
// think about, not a call it can omit.
func (w *Worker) deferDelivery(
	ctx context.Context, deliveryID string, budget deferBudget, reason Reason,
	delay time.Duration, log *slog.Logger, extra ...slog.Attr,
) {
	if budget.expired(w.now()) {
		w.expireDelivery(ctx, deliveryID, reason, log, extra...)
		return
	}
	// A defer that happened because WE are going away is named as such,
	// whatever the proximate reason was. A payload fetch cancelled by the drain
	// window is not an object-storage outage, and last_error must not send an
	// operator looking for one.
	if errors.Is(context.Cause(ctx), ErrWorkerShutdown) {
		reason = ReasonWorkerShutdown
	}
	if delay <= 0 {
		delay = time.Second
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), w.dbTimeout)
	defer cancel()

	err := w.store.Defer(writeCtx, w.workerID, deliveryID, Transition{
		State:  StateScheduled,
		Reason: reason,
		Delay:  delay,
	})
	attrs := append([]slog.Attr{
		slog.String("reason", string(reason)),
		slog.String("retry_in", delay.String()),
	}, extra...)
	if err != nil {
		if errors.Is(err, ErrLeaseNotHeld) {
			metrics.LeasesLost.WithLabelValues("defer").Inc()
			return
		}
		log.LogAttrs(writeCtx, slog.LevelError, "deferring delivery failed",
			append(attrs, slog.String("error", err.Error()))...)
		return
	}
	log.LogAttrs(writeCtx, slog.LevelDebug, "delivery deferred without an attempt", attrs...)
}

// expireDelivery ends a delivery whose wall-clock retry budget ran out while it
// was being deferred, rather than deferring it again.
//
// It writes a TERMINAL transition with no attempt row and no attempt count.
// That combination is the honest one: `exhausted` because we gave up rather
// than the endpoint rejecting us, reason `retry_duration_exhausted` because it
// was the clock and not the attempt count that ran out (which is the difference
// between an operator raising max_attempts and raising max_retry_duration), and
// no delivery_attempts row because no request was ever made. `deferred_for`
// records what had been holding it up, so the answer to "why did this never go
// out" is one query rather than a reconstruction.
func (w *Worker) expireDelivery(
	ctx context.Context, deliveryID string, deferredFor Reason, log *slog.Logger, extra ...slog.Attr,
) {
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), w.dbTimeout)
	defer cancel()

	next := Transition{State: StateExhausted, Reason: ReasonBudgetExhausted}
	attrs := append([]slog.Attr{
		slog.String("reason", string(ReasonBudgetExhausted)),
		slog.String("deferred_for", string(deferredFor)),
	}, extra...)

	if err := w.store.Complete(writeCtx, w.workerID, deliveryID, nil, next); err != nil {
		if errors.Is(err, ErrLeaseNotHeld) {
			metrics.LeasesLost.WithLabelValues("defer").Inc()
			return
		}
		log.LogAttrs(writeCtx, slog.LevelError, "expiring an out-of-budget delivery failed",
			append(attrs, slog.String("error", err.Error()))...)
		return
	}
	metrics.DeliveriesCompleted.WithLabelValues(string(StateExhausted)).Inc()
	log.LogAttrs(writeCtx, slog.LevelWarn,
		"delivery exhausted its retry duration without ever being attempted", attrs...)
}

// spread jitters a delay so deliveries turned away together do not return
// together. It is the same anti-stampede argument as retry jitter, applied to
// the paths that never reach the retry policy.
func (w *Worker) spread(d time.Duration) time.Duration {
	if d <= 0 {
		d = deferBaseDelay
	}
	jittered := time.Duration(float64(d) * w.rng.jitterFactor(0.3))
	if jittered < time.Second {
		jittered = time.Second
	}
	return jittered
}

func (w *Worker) dbContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, w.dbTimeout)
}

// storableBody bounds and sanitises a response body for the ledger.
//
// Two hazards, both real: PostgreSQL text cannot hold a NUL byte, and a 64 KB
// body on every attempt of every delivery is a table that grows faster than the
// deliveries themselves. Truncation is marked so nobody debugs a JSON parse
// error against a body we cut in half.
func (w *Worker) storableBody(resp *egress.Response) string {
	if resp == nil || len(resp.Body) == 0 {
		return ""
	}
	body := resp.Body
	truncated := resp.Truncated
	if len(body) > w.maxStoredBody {
		body = body[:w.maxStoredBody]
		truncated = true
	}
	s := strings.ReplaceAll(string(body), "\x00", "")
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	if truncated {
		s += "\n…[truncated]"
	}
	return s
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func attemptStatusCode(a *AttemptRecord) int {
	if a == nil {
		return 0
	}
	return a.HTTPStatus
}

func attemptDurationMS(a *AttemptRecord) int64 {
	if a == nil {
		return 0
	}
	return a.Duration.Milliseconds()
}

// hostOf extracts the host for logging. The full URL can carry a token in its
// query string, so only the host is logged (engineering rule 12).
func hostOf(raw string) string {
	if i := strings.Index(raw, "://"); i >= 0 {
		raw = raw[i+3:]
	}
	if i := strings.IndexAny(raw, "/?#"); i >= 0 {
		raw = raw[:i]
	}
	return raw
}
