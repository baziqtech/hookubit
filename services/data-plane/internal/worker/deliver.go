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
		w.deferDelivery(ctx, job.DeliveryID, ReasonConcurrencyLimited, w.spread(deferBaseDelay), log,
			slog.String("scope", scope))
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
		w.deferDelivery(ctx, j.DeliveryID, ReasonRetryScheduled, w.spread(deferBaseDelay), log)
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
		w.deferDelivery(ctx, job.DeliveryID, ReasonConcurrencyLimited, w.spread(deferBaseDelay), log)
		return
	}
	defer releaseEndpoint()

	breakerCtx, cancelBreaker := w.dbContext(ctx)
	verdict := w.breaker.Allow(breakerCtx, job.Endpoint.ID)
	cancelBreaker()
	if !verdict.Allowed {
		metrics.RateLimitHits.WithLabelValues("circuit_breaker").Inc()
		delay := verdict.RetryAfter.Sub(w.now())
		if delay < time.Second {
			delay = time.Second
		}
		w.deferDelivery(ctx, job.DeliveryID, verdict.Reason, delay, log,
			slog.String("breaker_state", string(verdict.State)))
		return
	}

	if job.Endpoint.RateLimit > 0 {
		allowed, wait := w.limiter.Allow(ctx, "endpoint:"+job.Endpoint.ID, job.Endpoint.RateLimit, job.Endpoint.RateLimitWindow)
		if !allowed {
			metrics.RateLimitHits.WithLabelValues("endpoint").Inc()
			w.deferDelivery(ctx, job.DeliveryID, ReasonRateLimited, w.spread(wait), log)
			return
		}
	}

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
		// events.payload_raw is authoritative. The jsonb column is a
		// normalised projection, so signing or sending it would produce a
		// payload the consumer cannot verify - see ErrNoPayload.
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

	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	decision := w.rng.decide(DecisionInput{
		Attempt:        job.AttemptNumber,
		Policy:         job.Policy,
		FirstAttemptAt: job.FirstAttemptAt,
		Now:            finished,
		Outcome:        Outcome{HTTPStatus: status, Err: doErr},
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

// deferDelivery puts a delivery back WITHOUT recording an attempt, because
// none was made. The retry budget is for endpoints that answered badly, not for
// moments when this process declined to ask.
//
// The reason is written to deliveries.last_error as well as the log. That
// column is the only free-text field the operator UI has, and "why is this
// delivery not moving" is the question it exists to answer; the alternative is
// a delivery sitting in `scheduled` with no explanation anywhere a human looks.
func (w *Worker) deferDelivery(
	ctx context.Context, deliveryID string, reason Reason, delay time.Duration, log *slog.Logger, extra ...slog.Attr,
) {
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
