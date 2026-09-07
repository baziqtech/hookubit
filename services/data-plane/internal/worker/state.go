package worker

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"os"
	"strings"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
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
	ReasonWorkerShutdown     Reason = "worker_shutdown"
)

// Outcome is what one attempt produced. Exactly one of HTTPStatus and Err is
// meaningful: a status means the endpoint answered, an error means it did not.
type Outcome struct {
	HTTPStatus int
	Err        error
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
	d.NextAttemptAt = in.Now.Add(in.Policy.Delay(in.Attempt+1, rng))
	return d
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
	if isTimeout(err) {
		return AttemptTimeout
	}
	return AttemptError
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
	case errors.Is(err, ErrNoPayload):
		return "payload_unavailable"
	case errors.Is(err, ErrSigning):
		return "signing_failed"
	case retry.IsBlockedTarget(err):
		return "blocked_target"
	case isTimeout(err):
		return "timeout"
	case retry.IsPermanentError(err):
		return "permanent"
	default:
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) {
			return "dns"
		}
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
