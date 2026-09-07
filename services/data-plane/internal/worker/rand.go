package worker

import (
	"math/rand"
	"sync"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
)

// lockedRand is a *rand.Rand behind a mutex.
//
// This exists because math/rand.Rand is NOT safe for concurrent use and the
// delivery path calls it from every worker goroutine - for retry jitter, for
// breaker cooldown jitter, for deferral spread. A data race in the jitter
// source is not a correctness bug you would ever see in a log; it is a `go test
// -race` failure at best and silent corruption of the generator's state at
// worst. The global rand.Float64 is already locked internally, but taking a
// *rand.Rand is what retry.Policy.Delay's signature asks for.
type lockedRand struct {
	mu sync.Mutex
	r  *rand.Rand
}

// newLockedRand seeds a generator. A zero seed means "seed from the clock",
// which is what production wants; tests pass a fixed seed for determinism.
func newLockedRand(seed int64) *lockedRand {
	if seed == 0 {
		seed = time.Now().UnixNano()
	}
	return &lockedRand{r: rand.New(rand.NewSource(seed))}
}

// delay computes a retry delay under the lock. retry.Policy.Delay takes a
// *rand.Rand, so this is the only place the generator is handed out, and it
// never escapes the mutex.
func (l *lockedRand) delay(p retry.Policy, attempt int) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	return p.Delay(attempt, l.r)
}

// float64 returns a locked random in [0,1).
func (l *lockedRand) float64() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.r.Float64()
}

// jitterFactor returns a locked multiplier in [1-ratio, 1+ratio].
func (l *lockedRand) jitterFactor(ratio float64) float64 {
	if ratio <= 0 {
		return 1
	}
	return 1 + (l.float64()*2-1)*ratio
}
