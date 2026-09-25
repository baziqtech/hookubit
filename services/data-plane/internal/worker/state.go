package worker

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/retry"
)

// State is a delivery lifecycle state (ARCHITECTURE.md 19). The values are the
// members of the PostgreSQL "DeliveryStatus" enum, so a typo is a compile error
// here and a constraint violation there rather than a row nobody can query.
type State string

const (
	StatePending    State = "pending"
	StateScheduled  State = "scheduled"
	StateQueued     State = "queued"
	StateProcessing State = "processing"
	StateSucceeded  State = "succeeded"
	StateFailed     State = "failed"
	StateRetrying   State = "retrying"
	StateExhausted  State = "exhausted"
	StateCancelled  State = "cancelled"
)

// Terminal reports whether no further attempt will ever be made.
func (s State) Terminal() bool {
	switch s {
	case StateSucceeded, StateFailed, StateExhausted, StateCancelled:
		return true
	default:
		return false
	}
}

// AttemptStatus is a member of the "AttemptStatus" enum on delivery_attempts.
type AttemptStatus string

const (
	AttemptSuccess AttemptStatus = "success"
	AttemptFailure AttemptStatus = "failure" // the endpoint answered, unacceptably
	AttemptTimeout AttemptStatus = "timeout"
	AttemptError   AttemptStatus = "error" // we never got an answer
)

// Reason is the free-text-but-enumerated explanation attached to every
// transition. ARCHITECTURE.md 19 requires one; making them constants means the
// operator UI can group by them and nobody invents a synonym at 2am.
type Reason string

const (
	ReasonDelivered          Reason = "delivered"
	ReasonNonRetryableStatus Reason = "non_retryable_http_status"
	ReasonPermanentError     Reason = "permanent_error"
	ReasonBlockedTarget      Reason = "blocked_target"
	ReasonRetryScheduled     Reason = "retry_scheduled"
	ReasonAttemptsExhausted  Reason = "attempts_exhausted"
	ReasonBudgetExhausted    Reason = "retry_duration_exhausted"
	ReasonEndpointDisabled   Reason = "endpoint_disabled"
	ReasonEndpointDeleted    Reason = "endpoint_deleted"
	ReasonBreakerOpen        Reason = "circuit_breaker_open"
	ReasonRateLimited        Reason = "rate_limited"
	ReasonConcurrencyLimited Reason = "concurrency_limit"
	ReasonSigningFailed      Reason = "signing_failed"
	ReasonPayloadUnavailable Reason = "payload_unavailable"
	// ReasonPayloadGone and ReasonPayloadCorrupt are OUR failures, and they are
	// separate reasons from everything above so that an operator answering
	// "what happened to this event" is never left thinking the customer's
	// endpoint rejected it.
	ReasonPayloadGone    Reason = "payload_object_missing"
	ReasonPayloadCorrupt Reason = "payload_hash_mismatch"
	ReasonWorkerShutdown Reason = "worker_shutdown"
)

// Outcome is what one attempt produced. Exactly one of HTTPStatus and Err is
// meaningful: a status means the endpoint answered, an error means it did not.
type Outcome struct {
	HTTPStatus int
	Err        error
	// RetryAfter is the endpoint's OWN requested wait, parsed from the
	// response's Retry-After header. HasRetryAfter distinguishes "the endpoint
	// asked for zero" from "the endpoint did not ask", which a bare zero
	// duration cannot.
	//
	// It is advisory input to Decide, never a command: see honourRetryAfter for
	// which statuses it applies to and clampRetryAfter for the bounds. An
	// endpoint that can name its own next attempt time without limit can hold a
	// delivery open past its retry budget or pin it in the queue forever.
	RetryAfter    time.Duration
	HasRetryAfter bool
}

// Decision is the state machine's verdict on one completed attempt.
type Decision struct {
	State         State
	Reason        Reason
	AttemptStatus AttemptStatus
	// NextAttemptAt is zero for a terminal decision.
	NextAttemptAt time.Time
	// ErrorCode is the coarse, low-cardinality classification stored on the
	// attempt row. It is derived, never a raw error string.
	ErrorCode string
	// RetryAfterHonoured reports that NextAttemptAt came from the endpoint's
	// Retry-After header rather than from the policy's backoff. It is carried
	// on the decision purely so the retry log line can say so; deliberately NOT
	// a new Reason, because `retry_scheduled` still describes the decision and
	// the reason values are a vocabulary the operator UI shares.
	RetryAfterHonoured bool
}

// DecisionInput is everything Decide needs. It takes no clock and no database:
// the state machine is a pure function so it can be exhaustively unit tested,
// which is the point of separating it from the delivery loop.
type DecisionInput struct {
	// Attempt is the 1-based number of the attempt that just completed.
	Attempt        int
	Policy         retry.Policy
	FirstAttemptAt time.Time
	Now            time.Time
	Outcome        Outcome
}

// Decide advances the delivery state machine for one completed attempt.
//
// The order of the checks is the whole design:
//
//  1. A 2xx succeeds, whatever else is true.
//  2. A failure that cannot change on a retry ends the delivery immediately -
//     retrying a 403 for 24 hours only burns the endpoint's rate budget.
//  3. Only then is the budget consulted, by attempts AND by wall clock.
//
// rng may be nil, in which case the retry delay carries no jitter. Callers on
// the delivery path must pass one: without jitter a thousand deliveries to one
// recovering endpoint stampede in lockstep.
func Decide(in DecisionInput, rng *rand.Rand) Decision {
	status, err := in.Outcome.HTTPStatus, in.Outcome.Err

	if err == nil && status >= 200 && status <= 299 {
		return Decision{State: StateSucceeded, Reason: ReasonDelivered, AttemptStatus: AttemptSuccess}
	}

	d := Decision{
		AttemptStatus: classifyAttempt(status, err),
		ErrorCode:     ErrorCode(status, err),
	}

	if !retry.ShouldRetry(status, err) {
		d.State = StateFailed
		switch {
		case retry.IsBlockedTarget(err):
			d.Reason = ReasonBlockedTarget
		case err != nil:
			d.Reason = ReasonPermanentError
		default:
			d.Reason = ReasonNonRetryableStatus
		}
		return d
	}

	// Exhausted is asked about the attempt that just finished: if it was the
	// last one the policy allows, there is no retry to schedule.
	if in.Policy.Exhausted(in.Attempt, in.FirstAttemptAt, in.Now) {
		d.State = StateExhausted
		d.Reason = ReasonAttemptsExhausted
		if in.Policy.MaxAttempts <= 0 || in.Attempt < in.Policy.MaxAttempts {
			// Attempts were still available, so it was the wall clock that ran
			// out. Naming which budget expired is the difference between an
			// operator raising max_attempts and raising max_retry_duration.
			d.Reason = ReasonBudgetExhausted
		}
		return d
	}

	d.State = StateRetrying
	d.Reason = ReasonRetryScheduled
	delay := in.Policy.Delay(in.Attempt+1, rng)
	if in.Outcome.HasRetryAfter && honourRetryAfter(status) {
		// The endpoint told us in advance that it will refuse us until then.
		// Retrying on our own schedule instead burns the delivery's budget on
		// requests we already know the answer to - and, on a 429, keeps the
		// pressure on an endpoint that is asking us to take it off.
		delay = clampRetryAfter(in.Outcome.RetryAfter, in.Policy, in.FirstAttemptAt, in.Now)
		d.RetryAfterHonoured = true
	}
	d.NextAttemptAt = in.Now.Add(delay)
	return d
}

// honourRetryAfter reports whether a status carries a Retry-After that means
// "come back then".
//
// 429 and 503 are the two RFC 9110 defines it for as a request to wait, and
// they are the two this platform retries. A Retry-After on a 3xx means
// something else entirely (how long the redirect is valid) and a Retry-After on
// a status we do not retry has nothing to schedule.
func honourRetryAfter(status int) bool {
	return status == 429 || status == 503
}

// clampRetryAfter bounds what an endpoint may ask for.
//
// Three bounds, each for a failure that is real:
//
//   - a floor of one second, because `Retry-After: 0` from a misbehaving
//     endpoint would schedule the next attempt at now() and turn the claim loop
//     into a hot loop against an endpoint that is already refusing us;
//   - the policy's MaxDelay, because `Retry-After: 999999999` (~31 years) from a
//     hostile or broken endpoint would otherwise park the delivery past any
//     horizon an operator can see, in a state that still reads as `retrying`;
//   - the remaining wall-clock budget, because scheduling an attempt after
//     first_attempt_at + max_retry_duration schedules an attempt that is
//     guaranteed to be judged exhausted the moment it runs. Landing ON the
//     boundary makes that judgement happen at the right time instead of a
//     Retry-After later.
func clampRetryAfter(d time.Duration, p retry.Policy, firstAttemptAt, now time.Time) time.Duration {
	if d < time.Second {
		d = time.Second
	}
	if p.MaxDelay > 0 && d > p.MaxDelay {
		d = p.MaxDelay
	}
	if remaining := p.Remaining(firstAttemptAt, now); d > remaining {
		d = remaining
	}
	if d < time.Second {
		// The budget is all but spent. One second is still better than zero:
		// the attempt is what turns a spent budget into `exhausted`, and a
		// zero delay would race the claim predicate.
		d = time.Second
	}
	return d
}

// ParseRetryAfter reads an RFC 9110 Retry-After value in either of its two
// forms - delay-seconds ("120") or an HTTP-date ("Wed, 21 Oct 2015 07:28:00
// GMT") - and returns it as a wait relative to now.
//
// The second return distinguishes "absent or unparseable" from "zero". A value
// in the past (a clock skew, or a date the endpoint has already passed) is a
// zero wait, not an absence: the endpoint DID answer the question.
func ParseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(value); err == nil {
		if secs < 0 {
			// Not a legal delay-seconds. Treat it as absent rather than as
			// "immediately": a negative here is a broken producer, and letting
			// it mean "now" hands it the hot loop.
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	if when, err := http.ParseTime(value); err == nil {
		d := when.Sub(now)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

// classifyAttempt maps an outcome onto the "AttemptStatus" enum. The
// distinction that matters to an operator is "the endpoint answered and we
// disliked the answer" (failure) versus "we never got one" (timeout/error).
func classifyAttempt(status int, err error) AttemptStatus {
	if err == nil {
		if status >= 200 && status <= 299 {
			return AttemptSuccess
		}
		return AttemptFailure
	}
	// DNS is asked about BEFORE timeout, and the order is the whole point.
	// The commonest DNS failure is an unresponsive nameserver, which IS a
	// timeout; classifying on that first files it as `timeout`, the same value
	// an endpoint that accepted the connection and then went silent produces.
	// AttemptTimeout is only worth having if it means the second thing.
	if isDNSError(err) {
		return AttemptError
	}
	if isTimeout(err) {
		return AttemptTimeout
	}
	return AttemptError
}

// isDNSError reports whether the failure happened while resolving the name.
// It matches on the TYPE for the same reason ErrorCode does: resolver error
// strings are not part of any API.
func isDNSError(err error) bool {
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	// http.Client's own overall-timeout error is a *url.Error whose Timeout()
	// is true, caught above; this catches the transport's string-only forms
	// that carry no typed timeout, as a last resort rather than a first one.
	return strings.Contains(err.Error(), "Client.Timeout exceeded")
}

// ErrorCode is the low-cardinality code stored on the attempt row and used as a
// metric label. It is derived from the error's TYPE, never from its message:
// transport error strings are not part of any API and a classifier that matches
// on them rots silently.
func ErrorCode(status int, err error) string {
	if err == nil {
		if status >= 200 && status <= 299 {
			return ""
		}
		return fmt.Sprintf("http_%d", status)
	}
	switch {
	case errors.Is(err, ErrPayloadGone):
		return "payload_object_missing"
	case errors.Is(err, ErrPayloadCorrupt):
		return "payload_hash_mismatch"
	case errors.Is(err, ErrNoPayload):
		return "payload_unavailable"
	case errors.Is(err, ErrSigning):
		return "signing_failed"
	case retry.IsBlockedTarget(err):
		return "blocked_target"
	// Named as DNS whether or not it timed out - see classifyAttempt. An
	// operator answering "what happened to this event" has to be able to tell
	// "their nameserver is down" from "their server is slow", and both arrive
	// here as an error whose Timeout() is true.
	case isDNSError(err):
		return "dns"
	case isTimeout(err):
		return "timeout"
	case retry.IsPermanentError(err):
		return "permanent"
	default:
		var opErr *net.OpError
		if errors.As(err, &opErr) {
			return "connection"
		}
		return "transport"
	}
}

// StatusClass buckets a status code for the egress_http_responses_total label,
// which must stay at five values however many status codes exist.
func StatusClass(status int, err error) string {
	switch {
	case err != nil:
		return "error"
	case status >= 200 && status <= 299:
		return "2xx"
	case status >= 300 && status <= 399:
		return "3xx"
	case status >= 400 && status <= 499:
		return "4xx"
	case status >= 500 && status <= 599:
		return "5xx"
	default:
		return "error"
	}
}
