package worker

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/shaq/hookubit/services/data-plane/internal/metrics"
)

func gaugeVecValue(t *testing.T, g *prometheus.GaugeVec, scope string) float64 {
	t.Helper()
	var m dto.Metric
	if err := g.WithLabelValues(scope).Write(&m); err != nil {
		t.Fatalf("read gauge{scope=%q}: %v", scope, err)
	}
	return m.GetGauge().GetValue()
}

// The gate's occupancy was, until it was published, entirely invisible:
// rate_limit_hits_total counted the REFUSALS, which says something was turned
// away and nothing at all about what was holding the capacity. That is the
// whole difficulty of G13 - the symptom (one tenant's deliveries are slow)
// shows up nowhere near the cause (a different tenant's endpoints are sitting
// on the pool).
func TestGateOccupancyReportsWhatIsHeldAtEachScope(t *testing.T) {
	g := NewGate(GateLimits{Global: 16, Org: 8, Project: 6, Endpoint: 4})

	// Two projects in one org, and one endpoint holding three slots against a
	// ceiling of four: the concentration this exists to make visible.
	var releases []Release
	for i := 0; i < 3; i++ {
		rel, _, ok := g.AcquireTenant("org_1", "proj_1")
		if !ok {
			t.Fatalf("tenant acquire %d refused below every ceiling", i)
		}
		releases = append(releases, rel)
		epRel, ok := g.AcquireEndpoint("ep_hot", 4, 4)
		if !ok {
			t.Fatalf("endpoint acquire %d refused below the ceiling", i)
		}
		releases = append(releases, epRel)
	}
	rel, _, ok := g.AcquireTenant("org_1", "proj_2")
	if !ok {
		t.Fatal("a second project in the same org was refused")
	}
	releases = append(releases, rel)
	epRel, ok := g.AcquireEndpoint("ep_quiet", 4, 4)
	if !ok {
		t.Fatal("a second endpoint was refused")
	}
	releases = append(releases, epRel)

	occ := g.Occupancy()

	global := occ[ScopeGlobal]
	if global.InUse != 4 || global.Capacity != 16 {
		t.Fatalf("global = %+v, want 4 of 16", global)
	}
	if global.Keys != 0 || global.BusiestKey != 0 {
		t.Fatalf("the global scope is unkeyed; got keys=%d busiest=%d", global.Keys, global.BusiestKey)
	}

	org := occ[ScopeOrg]
	if org.InUse != 4 || org.Keys != 1 || org.BusiestKey != 4 || org.Capacity != 8 {
		t.Fatalf("organization = %+v, want 4 slots in 1 key, busiest 4, capacity 8", org)
	}

	// The keyed scopes sum ACROSS keys, so InUse can exceed the per-key
	// Capacity. That is the shape of the gate, not a bug, and a dashboard
	// reading these has to know it.
	project := occ[ScopeProject]
	if project.InUse != 4 || project.Keys != 2 || project.BusiestKey != 3 {
		t.Fatalf("project = %+v, want 4 slots across 2 keys with the busiest at 3", project)
	}

	// THE series for G13: one endpoint holding three of the four slots, without
	// an endpoint id anywhere near a label.
	endpoint := occ[ScopeEndpoint]
	if endpoint.InUse != 4 || endpoint.Keys != 2 || endpoint.BusiestKey != 3 || endpoint.Capacity != 4 {
		t.Fatalf("endpoint = %+v, want 4 slots across 2 keys, busiest 3, capacity 4", endpoint)
	}

	for _, r := range releases {
		r()
	}
	after := g.Occupancy()
	for scope, o := range after {
		if o.InUse != 0 || o.Keys != 0 || o.BusiestKey != 0 {
			t.Fatalf("scope %s still holds %+v after every release; a leaked slot is a permanent "+
				"reduction in this process's capacity", scope, o)
		}
	}
}

// The gauges are what an operator actually sees. An instrument that is declared
// and never written reads as a confident zero, which is worse than absent -
// that was G9, and this is the assertion that stops G13's gauges repeating it.
func TestPublishOccupancyWritesThePoolAndGateGauges(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1", func(o *Options) {
		o.Concurrency = 7
		o.Limits = GateLimits{Global: 9, Org: 8, Project: 6, Endpoint: 4}
	})

	rel, _, ok := h.worker.gate.AcquireTenant("org_1", "proj_1")
	if !ok {
		t.Fatal("tenant acquire refused")
	}
	defer rel()
	epRel, ok := h.worker.gate.AcquireEndpoint("ep_1", 4, 4)
	if !ok {
		t.Fatal("endpoint acquire refused")
	}
	defer epRel()
	h.worker.inFlight.Store(5)

	metrics.WorkerPoolSlotsCapacity.Set(float64(h.worker.concurrency))
	h.worker.publishOccupancy()

	var m dto.Metric
	if err := metrics.WorkerPoolSlotsInUse.Write(&m); err != nil {
		t.Fatalf("read worker_pool_slots_in_use: %v", err)
	}
	if got := m.GetGauge().GetValue(); got != 5 {
		t.Fatalf("worker_pool_slots_in_use = %v, want 5", got)
	}
	if err := metrics.WorkerPoolSlotsCapacity.Write(&m); err != nil {
		t.Fatalf("read worker_pool_slots_capacity: %v", err)
	}
	if got := m.GetGauge().GetValue(); got != 7 {
		t.Fatalf("worker_pool_slots_capacity = %v, want 7 (WORKER_CONCURRENCY)", got)
	}

	for _, tc := range []struct {
		scope             string
		inUse, capacity   float64
		keys, busiestKeys float64
	}{
		{ScopeGlobal, 1, 9, 0, 0},
		{ScopeOrg, 1, 8, 1, 1},
		{ScopeProject, 1, 6, 1, 1},
		{ScopeEndpoint, 1, 4, 1, 1},
	} {
		if got := gaugeVecValue(t, metrics.GateSlotsInUse, tc.scope); got != tc.inUse {
			t.Fatalf("concurrency_gate_slots_in_use{scope=%q} = %v, want %v", tc.scope, got, tc.inUse)
		}
		if got := gaugeVecValue(t, metrics.GateSlotsCapacity, tc.scope); got != tc.capacity {
			t.Fatalf("concurrency_gate_slots_capacity{scope=%q} = %v, want %v", tc.scope, got, tc.capacity)
		}
		if got := gaugeVecValue(t, metrics.GateKeysActive, tc.scope); got != tc.keys {
			t.Fatalf("concurrency_gate_keys_active{scope=%q} = %v, want %v", tc.scope, got, tc.keys)
		}
		if got := gaugeVecValue(t, metrics.GateBusiestKeySlots, tc.scope); got != tc.busiestKeys {
			t.Fatalf("concurrency_gate_busiest_key_slots{scope=%q} = %v, want %v", tc.scope, got, tc.busiestKeys)
		}
	}
}
