package retry

import (
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/url"
	"testing"
	"time"
)

func TestFirstAttemptIsImmediate(t *testing.T) {
	p := DefaultPolicy()
	if d := p.Delay(1, nil); d != 0 {
		t.Fatalf("attempt 1 delay = %s, want 0", d)
	}
}

func TestExponentialGrowthAndCap(t *testing.T) {
	p := Policy{Strategy: "exponential", InitialDelay: 5 * time.Second, Multiplier: 2, MaxDelay: time.Minute}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, time.Minute, time.Minute}
	for i, w := range want {
		attempt := i + 2
		if got := p.Delay(attempt, nil); got != w {
			t.Fatalf("attempt %d delay = %s, want %s", attempt, got, w)
		}
	}
}

func TestJitterStaysWithinRatioAndVaries(t *testing.T) {
	p := Policy{Strategy: "constant", InitialDelay: 10 * time.Second, JitterRatio: 0.2}
	rng := rand.New(rand.NewSource(1))
	seen := map[time.Duration]bool{}
	for i := 0; i < 200; i++ {
		d := p.Delay(2, rng)
		if d < 8*time.Second || d > 12*time.Second {
			t.Fatalf("delay %s outside +/-20%% of 10s", d)
		}
		seen[d] = true
	}
	if len(seen) < 50 {
		t.Fatalf("jitter produced only %d distinct delays; a recovering endpoint would be stampeded", len(seen))
	}
}

func TestShouldRetryByStatus(t *testing.T) {
	retryable := []int{408, 429, 500, 502, 503, 504}
	for _, s := range retryable {
		if !ShouldRetry(s, nil) {
			t.Errorf("status %d should be retried", s)
		}
	}
	permanent := []int{200, 201, 204, 400, 401, 403, 404, 409, 410, 422}
	for _, s := range permanent {
		if ShouldRetry(s, nil) {
			t.Errorf("status %d should NOT be retried", s)
		}
	}
}

type blockedErr struct{}

func (blockedErr) Error() string       { return "blocked" }
func (blockedErr) BlockedTarget() bool { return true }

func TestSSRFRejectionIsNotRetried(t *testing.T) {
	if ShouldRetry(0, blockedErr{}) {
		t.Fatal("an SSRF policy rejection must never be retried")
	}
	if !ShouldRetry(0, errors.New("dial tcp: i/o timeout")) {
		t.Fatal("a transport error should be retried")
	}
}

func TestExhaustedByAttemptsOrDuration(t *testing.T) {
	p := Policy{MaxAttempts: 3, MaxRetryDuration: time.Hour}
	start := time.Unix(1_700_000_000, 0)

	if p.Exhausted(2, start, start.Add(time.Minute)) {
		t.Fatal("exhausted too early")
	}
	if !p.Exhausted(3, start, start.Add(time.Minute)) {
		t.Fatal("should be exhausted at max attempts")
	}
	// Budget can also run out on wall-clock age alone.
	if !p.Exhausted(2, start, start.Add(2*time.Hour)) {
		t.Fatal("should be exhausted by max retry duration")
	}
}

// Regression for the negative-delay overflow. The clamp used to be gated on
// `MaxDelay > 0`, so an uncapped exponential policy overflowed int64 and
// time.Duration(d) came back as math.MinInt64 - roughly -2562047h. A negative
// delay puts next_attempt_at permanently in the past, and the poll loop then
// re-claims and re-attempts a dead endpoint every 250ms forever.
func TestDelayIsNeverNegative(t *testing.T) {
	policies := map[string]Policy{
		"uncapped exponential":     {Strategy: "exponential", InitialDelay: 5 * time.Second, Multiplier: 2, MaxDelay: 0},
		"uncapped with jitter":     {Strategy: "exponential", InitialDelay: 5 * time.Second, Multiplier: 2, MaxDelay: 0, JitterRatio: 0.5},
		"uncapped linear":          {Strategy: "linear", InitialDelay: time.Hour, MaxDelay: 0},
		"uncapped constant":        {Strategy: "constant", InitialDelay: 30 * time.Second, MaxDelay: 0},
		"absurd multiplier":        {Strategy: "exponential", InitialDelay: time.Hour, Multiplier: 1e6, MaxDelay: 0},
		"capped exponential":       {Strategy: "exponential", InitialDelay: 5 * time.Second, Multiplier: 2, MaxDelay: time.Hour},
		"zero initial delay":       {Strategy: "exponential", InitialDelay: 0, Multiplier: 2, MaxDelay: 0},
		"jitter ratio above unity": {Strategy: "constant", InitialDelay: time.Second, JitterRatio: 3, MaxDelay: 0},
		"default":                  DefaultPolicy(),
	}

	rng := rand.New(rand.NewSource(7))
	for name, p := range policies {
		for attempt := 1; attempt <= 2000; attempt++ {
			for _, r := range []*rand.Rand{nil, rng} {
				d := p.Delay(attempt, r)
				if d < 0 {
					t.Fatalf("%s: Delay(%d) = %s; a negative backoff hammers a dead endpoint every poll", name, attempt, d)
				}
			}
		}
	}
}

// The uncapped policy must saturate at a large positive delay rather than wrap.
func TestUncappedDelaySaturates(t *testing.T) {
	p := Policy{Strategy: "exponential", InitialDelay: 5 * time.Second, Multiplier: 2, MaxDelay: 0}
	d := p.Delay(40, nil)
	if d <= 0 {
		t.Fatalf("Delay(40) = %s, want a large positive duration", d)
	}
	if d > time.Duration(maxDelayFloat) {
		t.Fatalf("Delay(40) = %s exceeds the representable clamp", d)
	}
	// Monotonic non-decreasing once saturated, never oscillating through zero.
	if next := p.Delay(41, nil); next < d {
		t.Fatalf("Delay(41) = %s < Delay(40) = %s", next, d)
	}
}

type permanentErr struct{}

func (permanentErr) Error() string                { return "structurally permanent" }
func (permanentErr) PermanentDeliveryError() bool { return true }

// Regression: IsRetryableNetworkError was `if errorsAs(...) { return true };
// return true`. Every transport failure was retried for the full 24h budget,
// including ones that cannot possibly succeed.
func TestPermanentTransportFailuresAreNotRetried(t *testing.T) {
	permanent := map[string]error{
		"explicitly marked": permanentErr{},
		"wrapped marker":    fmt.Errorf("attempt delivery: %w", permanentErr{}),
		"blocked target":    blockedErr{},
		"self-signed cert":  x509.UnknownAuthorityError{},
		"hostname mismatch": &url.Error{Op: "Post", URL: "https://x", Err: x509.HostnameError{Host: "x"}},
		"unknown authority wrapped": &url.Error{
			Op: "Post", URL: "https://x", Err: x509.UnknownAuthorityError{},
		},
	}
	for name, err := range permanent {
		if IsRetryableNetworkError(err) {
			t.Errorf("%s must not be retried", name)
		}
		if ShouldRetry(0, err) {
			t.Errorf("%s must not be retried via ShouldRetry", name)
		}
	}

	transient := map[string]error{
		"dial timeout":     &net.OpError{Op: "dial", Err: errors.New("i/o timeout")},
		"connection reset": errors.New("read: connection reset by peer"),
		"unexpected EOF":   io.ErrUnexpectedEOF,
		// Expiry heals when the operator renews the certificate, so it stays
		// retryable on purpose.
		"expired certificate": x509.CertificateInvalidError{Reason: x509.Expired},
	}
	for name, err := range transient {
		if !IsRetryableNetworkError(err) {
			t.Errorf("%s should be retried", name)
		}
	}

	if IsRetryableNetworkError(nil) {
		t.Error("a nil error is not a retryable failure")
	}
}

// DurationExhausted is the half of the budget a DEFERRED delivery spends.
//
// Regression it guards: the wall-clock cap used to be reachable only through
// Exhausted, which is only consulted when an attempt COMPLETES. A delivery that
// is refused before every attempt - a permanently open circuit breaker, a
// saturated rate limit - never completed one, so it was re-claimed and
// re-deferred forever with nothing ever asking whether its 24 hours were up.
func TestDurationExhausted(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	p := Policy{MaxAttempts: 8, MaxRetryDuration: 24 * time.Hour}

	cases := []struct {
		name  string
		first time.Time
		p     Policy
		want  bool
	}{
		{name: "fresh", first: now, p: p, want: false},
		{name: "most of the budget spent", first: now.Add(-23 * time.Hour), p: p, want: false},
		{name: "exactly at the boundary", first: now.Add(-24 * time.Hour), p: p, want: true},
		{name: "well past", first: now.Add(-72 * time.Hour), p: p, want: true},
		{
			// Nothing to measure against. A delivery with no origin must not be
			// terminated on a guess.
			name: "no first attempt time", first: time.Time{}, p: p, want: false,
		},
		{
			name: "no duration cap configured", first: now.Add(-1000 * time.Hour),
			p: Policy{MaxAttempts: 8}, want: false,
		},
		{
			// The attempt count is deliberately NOT consulted: a defer makes no
			// request, so it may not spend an attempt.
			name: "attempts are irrelevant here", first: now,
			p: Policy{MaxAttempts: 1, MaxRetryDuration: 24 * time.Hour}, want: false,
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.p.DurationExhausted(tc.first, now); got != tc.want {
				t.Fatalf("DurationExhausted = %v, want %v", got, tc.want)
			}
		})
	}
}

// Exhausted must keep agreeing with its two halves, or an operator reading
// `attempts_exhausted` when the clock ran out chases the wrong knob.
func TestExhaustedStillCoversBothBudgets(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	p := Policy{MaxAttempts: 3, MaxRetryDuration: time.Hour}

	if !p.Exhausted(3, now, now) {
		t.Fatal("the last allowed attempt did not exhaust the attempt budget")
	}
	if p.Exhausted(1, now, now) {
		t.Fatal("a first attempt inside both budgets was reported exhausted")
	}
	if !p.Exhausted(1, now.Add(-2*time.Hour), now) {
		t.Fatal("the wall-clock budget was not consulted by Exhausted")
	}
}

func TestRemaining(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	p := Policy{MaxRetryDuration: time.Hour}

	if got := p.Remaining(now.Add(-20*time.Minute), now); got != 40*time.Minute {
		t.Fatalf("Remaining = %s, want 40m", got)
	}
	if got := p.Remaining(now.Add(-2*time.Hour), now); got != 0 {
		t.Fatalf("Remaining on a spent budget = %s, want 0", got)
	}
	// "No cap" must not read as "no time left": callers use this as a ceiling,
	// and a zero would clamp every honoured Retry-After to nothing.
	if got := (Policy{}).Remaining(now, now); got < 100*365*24*time.Hour {
		t.Fatalf("Remaining with no duration cap = %s, want effectively unbounded", got)
	}
	if got := p.Remaining(time.Time{}, now); got < 100*365*24*time.Hour {
		t.Fatalf("Remaining with no origin = %s, want effectively unbounded", got)
	}
}
