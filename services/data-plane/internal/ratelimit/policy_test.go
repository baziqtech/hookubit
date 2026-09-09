package ratelimit

import (
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

const (
	orgID     = "org_01"
	projectID = "prj_01"
	keyID     = "key_01"
	endpntID  = "ep_01"
)

var target = Target{OrganizationID: orgID, ProjectID: projectID, APIKeyID: keyID, EndpointID: endpntID}

// TestResolutionOrder pins the order recorded in apps/control-api/HANDOFF.md.
//
// Two distinct rules are under test and they are easy to conflate, which is
// exactly what the handoff warns about:
//
//   - WITHIN a scope, a row naming the resource beats the resource_id IS NULL
//     row. Never both.
//   - ACROSS scopes these are nested budgets, so every applicable scope appears
//   - the specific one FIRST, so that when several would refuse it is the
//     most specific ceiling that is reported.
func TestResolutionOrder(t *testing.T) {
	def := Default{Limit: 1000, WindowSeconds: 1}

	cases := []struct {
		name string
		rows []Row
		// wantScopes is the ordered list of scopes charged.
		wantScopes []Scope
		// wantFirstLimit is the limit of the most specific bucket, which is
		// the one whose refusal is reported.
		wantFirstLimit int
		wantFirstKey   string
	}{
		{
			name:           "no rows at all falls back to the configured ingest default",
			rows:           nil,
			wantScopes:     []Scope{ScopeIngest},
			wantFirstLimit: 1000,
			wantFirstKey:   "rl:ingest:" + keyID + ":1s",
		},
		{
			name: "an ingest row for THIS api key beats the configured default",
			rows: []Row{
				{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 5, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest},
			wantFirstLimit: 5,
			wantFirstKey:   "rl:ingest:" + keyID + ":1s",
		},
		{
			name: "an ingest row for ANOTHER api key does not apply",
			rows: []Row{
				{Scope: ScopeIngest, ResourceID: ptr("key_other"), Limit: 5, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest},
			wantFirstLimit: 1000,
		},
		{
			name: "within the ingest scope the specific row beats the wildcard",
			rows: []Row{
				{Scope: ScopeIngest, ResourceID: nil, Limit: 50, WindowSeconds: 1},
				{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 7, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest},
			wantFirstLimit: 7,
		},
		{
			name: "an ingest wildcard row suppresses the configured default and is keyed per project",
			rows: []Row{
				{Scope: ScopeIngest, ResourceID: nil, Limit: 50, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest},
			wantFirstLimit: 50,
			// The wildcard is "every credential in this scope", so it must be
			// ONE shared bucket, not one per key.
			wantFirstKey: "rl:ingest:" + projectID + ":1s",
		},
		{
			name: "ingest, project and organization are all charged, most specific first",
			rows: []Row{
				{Scope: ScopeOrganization, ResourceID: ptr(orgID), Limit: 900, WindowSeconds: 1},
				{Scope: ScopeProject, ResourceID: ptr(projectID), Limit: 90, WindowSeconds: 1},
				{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 9, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest, ScopeProject, ScopeOrganization},
			wantFirstLimit: 9,
		},
		{
			name: "a project row with no ingest row still charges the ingest default underneath it",
			rows: []Row{
				{Scope: ScopeProject, ResourceID: ptr(projectID), Limit: 90, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest, ScopeProject},
			wantFirstLimit: 1000,
		},
		{
			name: "an organization wildcard applies when no row names this organization",
			rows: []Row{
				{Scope: ScopeOrganization, ResourceID: nil, Limit: 400, WindowSeconds: 60},
			},
			wantScopes:     []Scope{ScopeIngest, ScopeOrganization},
			wantFirstLimit: 1000,
		},
		{
			name: "endpoint rows never leak onto the ingest path",
			rows: []Row{
				{Scope: ScopeEndpoint, ResourceID: ptr(endpntID), Limit: 3, WindowSeconds: 1},
			},
			wantScopes:     []Scope{ScopeIngest},
			wantFirstLimit: 1000,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveIngest(tc.rows, target, def)
			assertScopes(t, got, tc.wantScopes)
			if got[0].Limit != tc.wantFirstLimit {
				t.Fatalf("most specific bucket limit = %d, want %d", got[0].Limit, tc.wantFirstLimit)
			}
			if tc.wantFirstKey != "" && got[0].Key != tc.wantFirstKey {
				t.Fatalf("most specific bucket key = %q, want %q", got[0].Key, tc.wantFirstKey)
			}
		})
	}
}

// TestDeliveryResolutionOrder covers the outbound chain: endpoint beats
// project beats organization. Nothing wires it yet, but the rule is one rule
// and this is what stops the two paths drifting.
func TestDeliveryResolutionOrder(t *testing.T) {
	cases := []struct {
		name       string
		rows       []Row
		wantScopes []Scope
		wantFirst  int
	}{
		{
			name:       "nothing configured charges nothing",
			rows:       nil,
			wantScopes: nil,
		},
		{
			name: "endpoint is the most specific and is charged first",
			rows: []Row{
				{Scope: ScopeOrganization, ResourceID: ptr(orgID), Limit: 300, WindowSeconds: 1},
				{Scope: ScopeProject, ResourceID: ptr(projectID), Limit: 30, WindowSeconds: 1},
				{Scope: ScopeEndpoint, ResourceID: ptr(endpntID), Limit: 3, WindowSeconds: 1},
			},
			wantScopes: []Scope{ScopeEndpoint, ScopeProject, ScopeOrganization},
			wantFirst:  3,
		},
		{
			name: "endpoint wildcard applies when no row names this endpoint",
			rows: []Row{
				{Scope: ScopeEndpoint, ResourceID: nil, Limit: 12, WindowSeconds: 1},
				{Scope: ScopeEndpoint, ResourceID: ptr("ep_other"), Limit: 1, WindowSeconds: 1},
			},
			wantScopes: []Scope{ScopeEndpoint},
			wantFirst:  12,
		},
		{
			name: "the ingest scope never leaks onto the delivery path",
			rows: []Row{
				{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 2, WindowSeconds: 1},
				{Scope: ScopeProject, ResourceID: ptr(projectID), Limit: 30, WindowSeconds: 1},
			},
			wantScopes: []Scope{ScopeProject},
			wantFirst:  30,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveDelivery(tc.rows, target)
			assertScopes(t, got, tc.wantScopes)
			if tc.wantFirst != 0 && got[0].Limit != tc.wantFirst {
				t.Fatalf("first bucket limit = %d, want %d", got[0].Limit, tc.wantFirst)
			}
		})
	}
}

func assertScopes(t *testing.T, got []Bucket, want []Scope) {
	t.Helper()
	if len(got) != len(want) {
		var names []Scope
		for _, b := range got {
			names = append(names, b.Scope)
		}
		t.Fatalf("charged %v, want %v", names, want)
	}
	for i, scope := range want {
		if got[i].Scope != scope {
			t.Fatalf("bucket %d scope = %q, want %q", i, got[i].Scope, scope)
		}
	}
}

// TestBurstIsTheCapacityAndLimitIsTheRate pins the handoff's arithmetic:
// `burst` is the bucket CAPACITY and `limit / window_seconds` the refill rate.
func TestBurstIsTheCapacityAndLimitIsTheRate(t *testing.T) {
	rows := []Row{{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 60, WindowSeconds: 60, Burst: ptr(100)}}
	b := ResolveIngest(rows, target, Default{})[0]

	if b.Capacity != 100 {
		t.Fatalf("capacity = %v, want the burst (100)", b.Capacity)
	}
	if b.RatePerSec != 1 {
		t.Fatalf("rate = %v/s, want limit/window = 1/s", b.RatePerSec)
	}
	if b.Window != time.Minute {
		t.Fatalf("window = %s, want 1m", b.Window)
	}

	// burst IS NULL means "capacity equals limit".
	rows[0].Burst = nil
	if c := ResolveIngest(rows, target, Default{})[0].Capacity; c != 60 {
		t.Fatalf("capacity with a null burst = %v, want the limit (60)", c)
	}
}

// A policy edit must change the bucket KEY only when the window changes, so an
// operator raising a limit does not hand out a whole fresh bucket.
func TestKeyIsStableAcrossALimitChange(t *testing.T) {
	a := ResolveIngest([]Row{{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 10, WindowSeconds: 1}}, target, Default{})[0]
	b := ResolveIngest([]Row{{Scope: ScopeIngest, ResourceID: ptr(keyID), Limit: 99, WindowSeconds: 1}}, target, Default{})[0]
	if a.Key != b.Key {
		t.Fatalf("raising a limit moved the bucket: %q -> %q", a.Key, b.Key)
	}
}
