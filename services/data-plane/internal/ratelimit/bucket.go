// Package ratelimit implements the platform's token buckets (ARCHITECTURE.md
// 25) and the resolution of `rate_limit_policies` rows onto them.
//
// Three pieces, deliberately separable:
//
//   - the ARITHMETIC (this file) is pure and shared. The Lua script in redis.go
//     is a transliteration of Take; keeping one readable Go reference means the
//     refill and burst behaviour can be tested exhaustively without Redis.
//   - the RESOLUTION (policy.go) turns rows into an ordered list of buckets.
//   - the TRANSPORT (redis.go, limiter.go) decides where the bucket state lives
//     and what happens when that store is unreachable.
//
// Nothing here fails closed. A limiter that refuses traffic because its store
// blipped has converted a cache outage into an ingest outage, and ingest is the
// one path ARCHITECTURE.md 14 says must never drop data.
package ratelimit

import (
	"math"
	"sort"
	"sync"
	"time"
)

// State is one bucket's persisted state: how many tokens it held, and when.
type State struct {
	Tokens float64
	At     time.Time
}

// Take applies one request of `cost` tokens to a bucket that refills at
// `ratePerSec` up to `capacity`.
//
// It returns the new state, whether the request may proceed, and - when it may
// not - how long until enough tokens have accrued. The wait is never zero on a
// refusal: a Retry-After of 0 invites an immediate retry, which is the one
// behaviour a rate limit exists to prevent.
func Take(s State, now time.Time, capacity, ratePerSec, cost float64) (State, bool, time.Duration) {
	if capacity <= 0 || ratePerSec <= 0 {
		// A bucket that can never hold or earn a token would refuse
		// everything forever. The control plane's CHECK constraints make this
		// unreachable from the API; a hand-written row or a bad default must
		// still not become an outage.
		return State{Tokens: 0, At: now}, true, 0
	}
	if cost <= 0 {
		cost = 1
	}

	tokens := s.Tokens
	if s.At.IsZero() {
		// First sight of this bucket: it starts full, so a client that has
		// been idle gets its whole burst.
		tokens = capacity
	} else if elapsed := now.Sub(s.At).Seconds(); elapsed > 0 {
		tokens += elapsed * ratePerSec
	}
	if tokens > capacity {
		tokens = capacity
	}

	if tokens >= cost {
		return State{Tokens: tokens - cost, At: now}, true, 0
	}

	// Not enough tokens. Charge nothing - a refused request must not push the
	// bucket further into debt, or a client retrying at the advertised
	// interval would never be served.
	deficit := cost - tokens
	wait := time.Duration(math.Ceil(deficit / ratePerSec * float64(time.Second)))
	if wait <= 0 {
		wait = time.Millisecond
	}
	return State{Tokens: tokens, At: now}, false, wait
}

// localIdleTTL is how long an unused bucket is kept before a sweep may drop it.
// Long enough that a once-a-minute caller keeps its state, short enough that
// the map tracks live callers rather than every caller ever seen.
const localIdleTTL = 10 * time.Minute

// DefaultLocalCapacity bounds the number of distinct keys one process tracks.
// It is a memory ceiling, not a tuning knob: each entry is a few dozen bytes,
// so 100k costs single-digit megabytes.
const DefaultLocalCapacity = 100_000

// Local is an in-process token bucket set.
//
// It is used for two different jobs, and the difference matters:
//
//  1. as the PRE-AUTH source limiter, where being per-process is the point -
//     the resource it protects (this pod's database connection pool) is
//     per-process too, and it must keep working when Redis does not; and
//  2. as the FALLBACK for the Redis limiter, where being per-process is a
//     known degradation: N replicas allow N x limit. That is deliberate. The
//     alternative on a Redis outage is no limit at all, or an ingest outage.
//
// Bounded on purpose. An attacker cycling source addresses (or an IPv6 /64
// walk) must not turn this into an unbounded allocation.
type Local struct {
	now func() time.Time
	max int

	mu         sync.Mutex
	buckets    map[string]*localEntry
	sweepAfter time.Time
}

type localEntry struct {
	state    State
	lastUsed time.Time
}

// NewLocal builds an in-process limiter. now may be nil; max <= 0 takes
// DefaultLocalCapacity.
func NewLocal(now func() time.Time, max int) *Local {
	if now == nil {
		now = time.Now
	}
	if max <= 0 {
		max = DefaultLocalCapacity
	}
	return &Local{now: now, max: max, buckets: make(map[string]*localEntry)}
}

// Allow charges `cost` tokens to key's bucket.
func (l *Local) Allow(key string, capacity, ratePerSec, cost float64) (bool, time.Duration) {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)

	entry, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.max {
			l.evictLocked(now)
		}
		entry = &localEntry{}
		l.buckets[key] = entry
	}
	state, allowed, wait := Take(entry.state, now, capacity, ratePerSec, cost)
	entry.state = state
	entry.lastUsed = now
	return allowed, wait
}

// Len reports how many buckets are currently tracked. Exported for tests and
// for the bounded-memory assertion; not on any hot path.
func (l *Local) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

func (l *Local) sweepLocked(now time.Time) {
	if now.Before(l.sweepAfter) {
		return
	}
	l.sweepAfter = now.Add(time.Minute)
	for key, entry := range l.buckets {
		if now.Sub(entry.lastUsed) > localIdleTTL {
			delete(l.buckets, key)
		}
	}
}

// evictLocked makes room when the map is full. Idle entries go first; if that
// is not enough, the least recently used quarter is dropped.
//
// Eviction is a correctness compromise and worth naming: the evicted key gets
// a full bucket next time it is seen. That is why the ceiling is high and the
// IPv6 keys are aggregated to a /64 - so reaching it takes a genuinely
// distributed flood, at which point a per-process map was never the defence.
func (l *Local) evictLocked(now time.Time) {
	for key, entry := range l.buckets {
		if now.Sub(entry.lastUsed) > localIdleTTL {
			delete(l.buckets, key)
		}
	}
	if len(l.buckets) < l.max {
		return
	}
	type aged struct {
		key  string
		when time.Time
	}
	all := make([]aged, 0, len(l.buckets))
	for key, entry := range l.buckets {
		all = append(all, aged{key, entry.lastUsed})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].when.Before(all[j].when) })
	for i := 0; i < len(all)/4+1; i++ {
		delete(l.buckets, all[i].key)
	}
}
