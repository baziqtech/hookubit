package worker

import (
	"context"
	"errors"
	"math/rand"
	"net"
	"net/http"
	"os"
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
	// The two shapes a DNS failure arrives in. Both must be named `dns`: the
	// first is an unresponsive nameserver (the common one) and the second is
	// NXDOMAIN. Before this was fixed the first was classified by isTimeout()
	// first and landed in the ledger as `timeout`, indistinguishable from an
	// endpoint that accepted the connection and then went silent.
	dnsTimeout := &net.DNSError{Err: "i/o timeout", IsTimeout: true}
	dnsMiss := &net.DNSError{Err: "no such host", Name: "endpoint.invalid"}
	// A genuine ENDPOINT timeout: the socket was open and the peer stopped
	// answering. This is what AttemptTimeout is FOR, and it must keep it.
	endpointTimeout := &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded}

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
			name:    "an unresponsive nameserver is named as DNS, not as a timeout",
			attempt: 1, outcome: Outcome{Err: dnsTimeout},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptError, wantErrorCode: "dns", wantRetryIn: 5 * time.Second,
		},
		{
			name: "NXDOMAIN is named as DNS too", attempt: 1, outcome: Outcome{Err: dnsMiss},
			wantState: StateRetrying, wantReason: ReasonRetryScheduled,
			wantAttempt: AttemptError, wantErrorCode: "dns", wantRetryIn: 5 * time.Second,
		},
		{
			name:    "an endpoint that stops answering an open socket is still a timeout",
			attempt: 1, outcome: Outcome{Err: endpointTimeout},
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

// --- Retry-After -----------------------------------------------------------

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		value string
		want  time.Duration
		ok    bool
	}{
		{name: "absent", value: "", want: 0, ok: false},
		{name: "delay seconds", value: "120", want: 2 * time.Minute, ok: true},
		{name: "delay seconds with surrounding space", value: "  30 ", want: 30 * time.Second, ok: true},
		{name: "zero is an answer, not an absence", value: "0", want: 0, ok: true},
		{
			// Not legal delay-seconds. Read as "immediately" it would hand a
			// broken producer a hot loop, so it is treated as no answer at all.
			name: "negative is not an answer", value: "-5", want: 0, ok: false,
		},
		{name: "http date in the future", value: "Wed, 09 Sep 2026 12:05:00 GMT", want: 5 * time.Minute, ok: true},
		{
			// Clock skew, or a date the endpoint has already passed. It DID
			// answer, and the answer is "now".
			name:  "http date in the past clamps to zero",
			value: "Wed, 09 Sep 2026 11:00:00 GMT", want: 0, ok: true,
		},
		{name: "garbage", value: "soon please", want: 0, ok: false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseRetryAfter(tc.value, now)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("duration = %s, want %s", got, tc.want)
			}
		})
	}
}

// The endpoint's own schedule wins over ours, within bounds it does not choose.
//
// Regression: before this, response headers were stored on the attempt row and
// otherwise unused, so an endpoint answering 429 with "Retry-After: 3600" was
// re-tried on the policy's five seconds - burning the delivery's budget on
// requests it had told us in advance it would refuse.
func TestRetryAfterIsHonouredAndClamped(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name         string
		status       int
		outcome      Outcome
		policy       func(retry.Policy) retry.Policy
		firstAttempt time.Time
		wantDelay    time.Duration
		wantHonoured bool
	}{
		{
			name:   "429 with a delay-seconds is honoured over the policy",
			status: 429, outcome: Outcome{RetryAfter: 15 * time.Minute, HasRetryAfter: true},
			wantDelay: 15 * time.Minute, wantHonoured: true,
		},
		{
			name: "503 carries it too", status: 503,
			outcome:   Outcome{RetryAfter: 90 * time.Second, HasRetryAfter: true},
			wantDelay: 90 * time.Second, wantHonoured: true,
		},
		{
			// A hostile or broken endpoint asking for ~31 years. Unclamped, the
			// delivery parks past any horizon an operator can see while still
			// reading as `retrying`.
			name:   "an absurd value is clamped to the policy's max delay",
			status: 429, outcome: Outcome{RetryAfter: 999999999 * time.Second, HasRetryAfter: true},
			wantDelay: time.Hour, wantHonoured: true,
		},
		{
			name:   "zero is floored to a second rather than becoming a hot loop",
			status: 429, outcome: Outcome{RetryAfter: 0, HasRetryAfter: true},
			wantDelay: time.Second, wantHonoured: true,
		},
		{
			// The wall-clock budget is the harder ceiling: scheduling past
			// first_attempt_at + max_retry_duration schedules an attempt that is
			// guaranteed to be judged exhausted the moment it runs.
			name:   "it may not push the delivery past its wall-clock budget",
			status: 429, outcome: Outcome{RetryAfter: 50 * time.Minute, HasRetryAfter: true},
			firstAttempt: now.Add(-40 * time.Minute),
			wantDelay:    20 * time.Minute, wantHonoured: true,
		},
		{
			name:   "a status that does not mean 'wait' is retried on the policy",
			status: 500, outcome: Outcome{RetryAfter: time.Hour, HasRetryAfter: true},
			wantDelay: 5 * time.Second,
		},
		{
			name: "no header at all is the policy", status: 429, outcome: Outcome{},
			wantDelay: 5 * time.Second,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			policy := testPolicy()
			if tc.policy != nil {
				policy = tc.policy(policy)
			}
			first := tc.firstAttempt
			if first.IsZero() {
				first = now
			}
			out := tc.outcome
			out.HTTPStatus = tc.status

			got := Decide(DecisionInput{
				Attempt: 1, Policy: policy, FirstAttemptAt: first, Now: now, Outcome: out,
			}, nil)

			if got.State != StateRetrying {
				t.Fatalf("state = %s, want retrying", got.State)
			}
			if got.Reason != ReasonRetryScheduled {
				t.Fatalf("reason = %s, want %s: honouring Retry-After is still a scheduled retry",
					got.Reason, ReasonRetryScheduled)
			}
			if delay := got.NextAttemptAt.Sub(now); delay != tc.wantDelay {
				t.Fatalf("next attempt in %s, want %s", delay, tc.wantDelay)
			}
			if got.RetryAfterHonoured != tc.wantHonoured {
				t.Fatalf("RetryAfterHonoured = %v, want %v", got.RetryAfterHonoured, tc.wantHonoured)
			}
		})
	}
}

// Retry-After cannot resurrect a delivery whose budget is already spent: the
// exhaustion check runs first and there is no retry to schedule.
func TestRetryAfterCannotExtendAnExhaustedDelivery(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	got := Decide(DecisionInput{
		Attempt:        1,
		Policy:         testPolicy(),
		FirstAttemptAt: now.Add(-2 * time.Hour), // MaxRetryDuration is an hour
		Now:            now,
		Outcome:        Outcome{HTTPStatus: 429, RetryAfter: time.Minute, HasRetryAfter: true},
	}, nil)

	if got.State != StateExhausted || got.Reason != ReasonBudgetExhausted {
		t.Fatalf("decision = (%s, %s), want (exhausted, %s)", got.State, got.Reason, ReasonBudgetExhausted)
	}
	if !got.NextAttemptAt.IsZero() {
		t.Fatalf("a terminal decision carried a next attempt time: %s", got.NextAttemptAt)
	}
}

// The header is read off the response, not invented, and the two forms both
// reach Decide. This is the seam between net/http and the pure state machine.
func TestRetryAfterHeaderReachesTheDecision(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	h := http.Header{}
	h.Set("Retry-After", "45")

	wait, ok := ParseRetryAfter(h.Get("Retry-After"), now)
	if !ok || wait != 45*time.Second {
		t.Fatalf("parsed (%s, %v), want (45s, true)", wait, ok)
	}
	got := Decide(DecisionInput{
		Attempt: 1, Policy: testPolicy(), FirstAttemptAt: now, Now: now,
		Outcome: Outcome{HTTPStatus: 429, RetryAfter: wait, HasRetryAfter: ok},
	}, nil)
	if delay := got.NextAttemptAt.Sub(now); delay != 45*time.Second {
		t.Fatalf("next attempt in %s, want 45s", delay)
	}
}
