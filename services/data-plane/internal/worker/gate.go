package worker

import "sync"

// Gate is the tenant fairness mechanism (ARCHITECTURE.md 24) and the reason
// this service is written in Go.
//
// Four nested ceilings - global, organisation, project, endpoint - are checked
// with a NON-BLOCKING acquire. That is the important word. A blocking acquire
// would park a worker goroutine in front of one slow endpoint, which is exactly
// how one customer's 30-second timeouts starve everybody else: the pool fills
// with goroutines waiting on a semaphore nobody is releasing. Instead a full
// gate DEFERS the delivery - it goes straight back to the ready set with a
// short jittered delay, no attempt row, no attempt burned - and the worker
// moves on to the next job.
//
// The gate is per-process. With N worker processes the effective ceiling is N
// times these numbers; the per-endpoint ceiling that must hold across the fleet
// is the rate limit, which is designed to be moved into Redis. See HANDOFF.md.
type Gate struct {
	global   *counter
	org      *keyedCounter
	project  *keyedCounter
	endpoint *keyedCounter

	orgLimit     int
	projectLimit int
}

// GateLimits are the configured ceilings (MAX_CONCURRENCY_*).
type GateLimits struct {
	Global   int
	Org      int
	Project  int
	Endpoint int
}

// NewGate builds the ceiling set. A non-positive limit is treated as 1 rather
// than as "unlimited": an unbounded concurrency ceiling is not a configuration,
// it is the absence of one, and engineering rule 29 forbids it.
func NewGate(l GateLimits) *Gate {
	return &Gate{
		global:       &counter{limit: atLeastOne(l.Global)},
		org:          newKeyedCounter(),
		project:      newKeyedCounter(),
		endpoint:     newKeyedCounter(),
		orgLimit:     atLeastOne(l.Org),
		projectLimit: atLeastOne(l.Project),
	}
}

// Release returns capacity acquired from the gate. Always call it, exactly
// once, including on the error paths - a leaked slot is a permanent reduction
// in this process's capacity that no restart-free remedy will recover.
type Release func()

// AcquireTenant takes the global, organisation and project slots for one
// delivery. It reports the scope that refused so the deferral reason and the
// rate_limit_hits_total label say WHICH ceiling was hit; guessing between them
// from a saturated dashboard is the difference between raising a limit and
// scaling out.
//
// The endpoint slot is taken separately, by AcquireEndpoint, because the
// endpoint's own max_concurrency is only known once its row has been read.
func (g *Gate) AcquireTenant(orgID, projectID string) (Release, string, bool) {
	if !g.global.tryAcquireOwnLimit() {
		return nil, "global", false
	}
	if !g.org.tryAcquire(orgID, g.orgLimit) {
		g.global.release()
		return nil, "organization", false
	}
	if !g.project.tryAcquire(projectID, g.projectLimit) {
		g.org.release(orgID)
		g.global.release()
		return nil, "project", false
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			g.project.release(projectID)
			g.org.release(orgID)
			g.global.release()
		})
	}, "", true
}

// AcquireEndpoint takes the per-endpoint slot. capacity is the endpoint's own
// endpoints.max_concurrency; the configured ceiling is the upper bound, so a
// customer cannot raise their own limit past what the deployment allows.
func (g *Gate) AcquireEndpoint(endpointID string, capacity, ceiling int) (Release, bool) {
	limit := atLeastOne(ceiling)
	if capacity > 0 && capacity < limit {
		limit = capacity
	}
	if !g.endpoint.tryAcquire(endpointID, limit) {
		return nil, false
	}
	var once sync.Once
	return func() { once.Do(func() { g.endpoint.release(endpointID) }) }, true
}

// InFlight reports the number of deliveries currently holding a global slot.
func (g *Gate) InFlight() int { return g.global.inFlight() }

func atLeastOne(n int) int {
	if n < 1 {
		return 1
	}
	return n
}

// counter is a plain semaphore. It is a mutex and an int rather than a buffered
// channel because the capacity has to be changeable: an endpoint's
// max_concurrency is edited in the control plane while the worker is running.
type counter struct {
	mu    sync.Mutex
	held  int
	limit int
}

// tryAcquireOwnLimit takes a slot against the counter's configured limit.
//
// It reads `limit` INSIDE the mutex on purpose. The obvious spelling -
// `tryAcquire(g.global.limit)` at the call site - reads the field unsynchronised
// from every worker goroutine, which the race detector catches and which is a
// genuine bug the moment the limit becomes reconfigurable.
func (c *counter) tryAcquireOwnLimit() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.held >= c.limit {
		return false
	}
	c.held++
	return true
}

func (c *counter) release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.held > 0 {
		c.held--
	}
}

func (c *counter) inFlight() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.held
}

// keyedCounter is one semaphore per tenant key. Entries are deleted when they
// fall to zero, so the map is bounded by concurrent tenants rather than by the
// customer list - the same cardinality discipline the metrics package applies.
type keyedCounter struct {
	mu      sync.Mutex
	entries map[string]*entry
}

type entry struct {
	held  int
	limit int
}

func newKeyedCounter() *keyedCounter {
	return &keyedCounter{entries: make(map[string]*entry)}
}

func (k *keyedCounter) tryAcquire(key string, limit int) bool {
	if limit < 1 {
		limit = 1
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	e, ok := k.entries[key]
	if !ok {
		e = &entry{limit: limit}
		k.entries[key] = e
	} else if e.held == 0 {
		e.limit = limit
	}
	if e.held >= e.limit {
		return false
	}
	e.held++
	return true
}

func (k *keyedCounter) release(key string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	e, ok := k.entries[key]
	if !ok {
		return
	}
	e.held--
	if e.held <= 0 {
		delete(k.entries, key)
	}
}

func (k *keyedCounter) inFlight(key string) int {
	k.mu.Lock()
	defer k.mu.Unlock()
	if e, ok := k.entries[key]; ok {
		return e.held
	}
	return 0
}

// keys reports how many distinct keys currently hold capacity. Test helper for
// the "entries are freed" property.
func (k *keyedCounter) keys() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.entries)
}
