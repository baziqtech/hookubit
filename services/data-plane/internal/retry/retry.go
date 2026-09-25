// Package retry computes delivery backoff (ARCHITECTURE.md 21).
//
// Policies are data, loaded per endpoint from retry_policies. Nothing here is
// hard-coded permanently; the defaults exist only so an endpoint created
// without an explicit policy still behaves sensibly.
package retry

import (
	"math"
	"math/rand"
	"time"
)

// Policy mirrors the retry_policies row.
type Policy struct {
	Strategy         string // exponential | linear | constant
	MaxAttempts      int
	InitialDelay     time.Duration
	MaxDelay         time.Duration
	Multiplier       float64
	JitterRatio      float64 // 0..1 of the computed delay
	MaxRetryDuration time.Duration
}

// DefaultPolicy is used when an endpoint has no policy attached.
func DefaultPolicy() Policy {
	return Policy{
		Strategy:         "exponential",
		MaxAttempts:      8,
		InitialDelay:     5 * time.Second,
		MaxDelay:         time.Hour,
		Multiplier:       2,
		JitterRatio:      0.2,
		MaxRetryDuration: 24 * time.Hour,
	}
}

// Delay returns the wait before the given attempt number (1-based: attempt 1 is
// the first delivery and always immediate). Jitter is applied last so that a
// thousand deliveries to one recovering endpoint do not stampede in lockstep.
func (p Policy) Delay(attempt int, rng *rand.Rand) time.Duration {
	if attempt <= 1 {
		return 0
	}
	n := float64(attempt - 2) // 0 for the first retry

	var d float64
	switch p.Strategy {
	case "constant":
		d = float64(p.InitialDelay)
	case "linear":
		d = float64(p.InitialDelay) * (n + 1)
	default: // exponential
		mult := p.Multiplier
		if mult <= 1 {
			mult = 2
		}
		d = float64(p.InitialDelay) * math.Pow(mult, n)
	}

	// Clamp unconditionally, BEFORE the conversion to time.Duration.
	//
	// Regression guard: this clamp used to be gated on `p.MaxDelay > 0`, so a
	// policy with MaxDelay unset let math.Pow run away - at attempt 40 with a
	// 5s base and multiplier 2, d is ~1.5e19, which overflows int64 and makes
	// time.Duration(d) math.MinInt64. next_attempt_at then lands permanently in
	// the past and the poll loop hammers a dead endpoint every 250ms: exactly
	// the stampede backoff exists to prevent. The old `if d < 0` guard could
	// never catch it, because the float was still positive when it ran.
	d = clampDelay(d)
	if p.MaxDelay > 0 && d > float64(p.MaxDelay) {
		d = float64(p.MaxDelay)
	}
	if p.JitterRatio > 0 && rng != nil {
		// Symmetric jitter around the computed delay.
		jitter := d * p.JitterRatio
		d += (rng.Float64()*2 - 1) * jitter
	}
	return time.Duration(clampDelay(d))
}

// maxDelayFloat is the largest value we will ever hand to time.Duration. It is
// 2^62 nanoseconds (~146 years), exactly representable as a float64 and
// comfortably below math.MaxInt64 - note that float64(math.MaxInt64) rounds UP
// past MaxInt64, so it is not itself a safe bound to compare against.
const maxDelayFloat = float64(1 << 62)

// clampDelay maps any float - including NaN and +/-Inf, which math.Pow produces
// on runaway policies - into a range time.Duration can represent.
func clampDelay(d float64) float64 {
	switch {
	case math.IsNaN(d):
		return 0
	case d < 0:
		return 0
	case d > maxDelayFloat:
		return maxDelayFloat
	default:
		return d
	}
}

// ShouldRetry decides whether a delivery attempt is worth repeating.
// Network-level failures always are. Of the HTTP statuses only 408, 429 and 5xx
// are, because a 400 or a 403 will be a 400 or a 403 forever and retrying it
// only burns the endpoint's rate budget (ARCHITECTURE.md 21).
func ShouldRetry(httpStatus int, err error) bool {
	if err != nil {
		return IsRetryableNetworkError(err)
	}
	switch {
	case httpStatus == 408, httpStatus == 429:
		return true
	case httpStatus >= 500 && httpStatus <= 599:
		return true
	default:
		return false
	}
}

// IsRetryableNetworkError reports whether a transport-level failure is worth
// repeating. Connection, DNS and timeout failures are; anything structurally
// permanent is not, because it will fail identically on every retry and we
// would burn a 24h retry budget proving it.
//
// The classification is deliberately a deny-list of known-permanent failures
// with a retry default, not the reverse: an unrecognised transport error is far
// more likely to be a transient network fault than a permanent one, and giving
// up on a delivery we could have made is the worse of the two mistakes.
//
// This function previously read `if errorsAs(&netErr) { return true }; return
// true` - the branch was dead and every error, including a malformed URL and a
// self-signed certificate, was retried for a day.
func IsRetryableNetworkError(err error) bool {
	if err == nil {
		return false
	}
	// An SSRF policy rejection: the same URL is refused identically forever.
	if IsBlockedTarget(err) {
		return false
	}
	// Explicitly marked by the egress client at the call site (a request that
	// cannot be built, a response we may already have been delivered).
	if IsPermanentError(err) {
		return false
	}
	// Certificate trust and hostname mismatches: an operator must fix the
	// endpoint's certificate, and no amount of retrying does that. Expiry is
	// deliberately NOT in this set - that one heals when the cert is renewed.
	if isPermanentTLSError(err) {
		return false
	}
	return true
}

// Exhausted reports whether a delivery has run out of budget, by attempts or by
// wall-clock age. The duration cap matters: eight attempts with an hour cap
// would otherwise keep a dead endpoint's rows hot for days.
func (p Policy) Exhausted(attempt int, firstAttemptAt time.Time, now time.Time) bool {
	if p.MaxAttempts > 0 && attempt >= p.MaxAttempts {
		return true
	}
	return p.DurationExhausted(firstAttemptAt, now)
}

// DurationExhausted is the WALL-CLOCK half of Exhausted, on its own.
//
// It is separate because the two halves are spent by different things. An
// attempt is spent only by a request that was actually made, so a delivery the
// worker declined to send - an open breaker, a rate limit, a concurrency
// ceiling - must not consume one. Wall-clock time is spent by the clock, which
// does not care whether we asked. A delivery that is only ever DEFERRED
// therefore has a budget that can still run out, and something has to be able
// to ask that question without pretending an attempt happened.
//
// Without this, a delivery to a permanently dead endpoint whose breaker never
// closes is re-claimed and re-deferred forever: Exhausted is only consulted
// when an attempt completes, and no attempt ever does.
func (p Policy) DurationExhausted(firstAttemptAt time.Time, now time.Time) bool {
	if p.MaxRetryDuration <= 0 || firstAttemptAt.IsZero() {
		return false
	}
	return now.Sub(firstAttemptAt) >= p.MaxRetryDuration
}

// Remaining reports how much wall-clock budget a delivery has left. It is zero
// when the budget is spent and, when no duration cap applies, the largest
// duration - callers use it as a ceiling, and "no cap" must not read as "no
// time left".
func (p Policy) Remaining(firstAttemptAt time.Time, now time.Time) time.Duration {
	if p.MaxRetryDuration <= 0 || firstAttemptAt.IsZero() {
		return time.Duration(math.MaxInt64)
	}
	left := firstAttemptAt.Add(p.MaxRetryDuration).Sub(now)
	if left < 0 {
		return 0
	}
	return left
}
