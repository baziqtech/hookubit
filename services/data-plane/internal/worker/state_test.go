package worker

import (
	"context"
	"errors"
	"math/rand"
	"net"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/egress"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
)

func testPolicy() retry.Policy {
	return retry.Policy{
		Strategy:         "exponential",
		MaxAttempts:      3,
		InitialDelay:     5 * time.Second,
		MaxDelay:         time.Hour,
		Multiplier:       2,
		JitterRatio:      0,
		MaxRetryDuration: time.Hour,
	}
}

func TestDecideStateMachine(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	blocked := &egress.BlockedTargetError{Target: "http://169.254.169.254/", Reason: "metadata service"}
	permanent := &egress.PermanentError{Op: "build request", Err: errors.New("bad method")}
	timeout := &net.DNSError{Err: "i/o timeout", IsTimeout: true}

	cases := []struct {
		name          string
		attempt       int
		outcome       Outcome
		firstAttempt  time.Time
		wantState     State
		wantReason    Reason
		wantAttempt   AttemptStatus
		wantErrorCode string
		wantRetryIn   time.Duration
	}{
		{
			name: "2xx succeeds", attempt: 1, outcome: Outcome{HTTPStatus: 200},
			wantState: StateSucceeded, wantReason: ReasonDelivered, wantAttempt: AttemptSuccess,
		},
		{
			name: "204 succeeds", attempt: 2, outcome: Outcome{HTTPStatus: 204},
			wantState: StateSucceeded, wantReason: ReasonDelivered, wantAttempt: AttemptSuccess,
		},
		{
			name: "400 is permanent", attempt: 1, outcome: Outcome{HTTPStatus: 400},
			wantState: StateFailed, wantReason: ReasonNonRetryableStatus,
			wantAttempt: AttemptFailure, wantErrorCode: "http_400",
		},
		{
			name: "403 is permanent", attempt: 1, outcome: Outcome{HTTPStatus: 403},
			wantState: StateFailed, wantReason: ReasonNonRetryableStatus,
			wantAttempt: AttemptFailure, wantErrorCode: "http_403",
		},
		{
			name: "302 with no redirect followed is permanent", attempt: 1, outcome: Outcome{HTTPStatus: 302},
			wantState: StateFailed, wantReason: ReasonNonRetryableStatus,
			wantAttempt: AttemptFailure, wantErrorCode: "http_302",
		},
		{
			name: "408 retries", attempt: 1, outcome: Outcome{HTTPStatus: 408},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptFailure, wantErrorCode: "http_408", wantRetryIn: 5 * time.Second,
		},
		{
			name: "429 retries", attempt: 1, outcome: Outcome{HTTPStatus: 429},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptFailure, wantErrorCode: "http_429", wantRetryIn: 5 * time.Second,
		},
		{
			name: "500 retries with exponential backoff", attempt: 2, outcome: Outcome{HTTPStatus: 500},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptFailure, wantErrorCode: "http_500", wantRetryIn: 10 * time.Second,
		},
		{
			name: "last allowed attempt exhausts", attempt: 3, outcome: Outcome{HTTPStatus: 503},
			wantState: StateExhausted, wantReason: ReasonAttemptsExhausted, wantAttempt: AttemptFailure,
			wantErrorCode: "http_503",
		},
		{
			name: "wall clock budget exhausts before attempts", attempt: 1, outcome: Outcome{HTTPStatus: 503},
			firstAttempt: now.Add(-2 * time.Hour),
			wantState:    StateExhausted, wantReason: ReasonBudgetExhausted, wantAttempt: AttemptFailure,
			wantErrorCode: "http_503",
		},
		{
			name: "timeout retries and is classified as a timeout", attempt: 1, outcome: Outcome{Err: timeout},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptTimeout, wantErrorCode: "timeout", wantRetryIn: 5 * time.Second,
		},
		{
			name: "context deadline is a timeout", attempt: 1, outcome: Outcome{Err: context.DeadlineExceeded},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptTimeout, wantErrorCode: "timeout", wantRetryIn: 5 * time.Second,
		},
		{
			name: "an SSRF rejection never retries", attempt: 1, outcome: Outcome{Err: blocked},
			wantState: StateFailed, wantReason: ReasonBlockedTarget,
			wantAttempt: AttemptError, wantErrorCode: "blocked_target",
		},
		{
			name: "an explicitly permanent transport error never retries", attempt: 1, outcome: Outcome{Err: permanent},
			wantState: StateFailed, wantReason: ReasonPermanentError,
			wantAttempt: AttemptError, wantErrorCode: "permanent",
		},
		{
			name: "an unrecognised transport error retries", attempt: 1, outcome: Outcome{Err: errors.New("connection reset")},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptError, wantErrorCode: "transport", wantRetryIn: 5 * time.Second,
		},
		{
			name: "a signing failure retries but is coded distinctly", attempt: 1, outcome: Outcome{Err: ErrSigning},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptError, wantErrorCode: "signing_failed", wantRetryIn: 5 * time.Second,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			first := tc.firstAttempt
			if first.IsZero() {
				first = now
			}
			got := Decide(DecisionInput{
				Attempt:        tc.attempt,
				Policy:         testPolicy(),
				FirstAttemptAt: first,
				Now:            now,
				Outcome:        tc.outcome,
			}, nil)

			if got.State != tc.wantState {
				t.Fatalf("state = %s, want %s", got.State, tc.wantState)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("reason = %s, want %s", got.Reason, tc.wantReason)
			}
			if got.AttemptStatus != tc.wantAttempt {
				t.Fatalf("attempt status = %s, want %s", got.AttemptStatus, tc.wantAttempt)
			}
			if got.ErrorCode != tc.wantErrorCode {
				t.Fatalf("error code = %q, want %q", got.ErrorCode, tc.wantErrorCode)
			}
			if tc.wantRetryIn > 0 {
				if got.NextAttemptAt.Sub(now) != tc.wantRetryIn {
					t.Fatalf("retry delay = %s, want %s", got.NextAttemptAt.Sub(now), tc.wantRetryIn)
				}
			} else if !got.NextAttemptAt.IsZero() {
				t.Fatalf("terminal decision carried a next attempt time: %s", got.NextAttemptAt)
			}
		})
	}
}

// Every transition must carry a reason (ARCHITECTURE.md 19). A blank reason is
// a delivery an operator cannot explain.
func TestEveryDecisionCarriesAReason(t *testing.T) {
	now := time.Now()
	outcomes := []Outcome{
		{HTTPStatus: 200}, {HTTPStatus: 404}, {HTTPStatus: 500}, {HTTPStatus: 429},
		{Err: errors.New("boom")}, {Err: context.DeadlineExceeded},
		{Err: &egress.BlockedTargetError{Target: "x", Reason: "y"}},
	}
	for _, attempt := range []int{1, 2, 3, 9} {
		for _, o := range outcomes {
			d := Decide(DecisionInput{
				Attempt: attempt, Policy: testPolicy(), FirstAttemptAt: now, Now: now, Outcome: o,
			}, nil)
			if d.Reason == "" {
				t.Fatalf("attempt %d outcome %+v produced a transition with no reason", attempt, o)
			}
			if d.State == "" {
				t.Fatalf("attempt %d outcome %+v produced no state", attempt, o)
			}
		}
	}
}

func TestRetryScheduleGrowsAndIsJittered(t *testing.T) {
	now := time.Now()
	policy := testPolicy()
	policy.MaxAttempts = 10
	policy.JitterRatio = 0.2
	rng := rand.New(rand.NewSource(1))

	var previous time.Duration
	for attempt := 1; attempt <= 5; attempt++ {
		d := Decide(DecisionInput{
			Attempt: attempt, Policy: policy, FirstAttemptAt: now, Now: now,
			Outcome: Outcome{HTTPStatus: 503},
		}, rng)
		if d.State != StateRetrying {
			t.Fatalf("attempt %d: state = %s, want retrying", attempt, d.State)
		}
		delay := d.NextAttemptAt.Sub(now)
		if delay <= 0 {
			t.Fatalf("attempt %d: non-positive retry delay %s", attempt, delay)
		}
		if attempt > 1 && delay <= previous {
			t.Fatalf("attempt %d: delay %s did not grow beyond %s", attempt, delay, previous)
		}
		previous = delay
	}
}

func TestStatusClassStaysLowCardinality(t *testing.T) {
	cases := map[int]string{200: "2xx", 301: "3xx", 404: "4xx", 500: "5xx", 0: "error"}
	for status, want := range cases {
		if got := StatusClass(status, nil); got != want {
			t.Fatalf("StatusClass(%d) = %s, want %s", status, got, want)
		}
	}
	if got := StatusClass(200, errors.New("x")); got != "error" {
		t.Fatalf("an error must class as error, got %s", got)
	}
}

func TestTerminalStates(t *testing.T) {
	terminal := []State{StateSucceeded, StateFailed, StateExhausted, StateCancelled}
	nonTerminal := []State{StatePending, StateScheduled, StateQueued, StateProcessing, StateRetrying}
	for _, s := range terminal {
		if !s.Terminal() {
			t.Fatalf("%s must be terminal", s)
		}
	}
	for _, s := range nonTerminal {
		if s.Terminal() {
			t.Fatalf("%s must not be terminal", s)
		}
	}
}
