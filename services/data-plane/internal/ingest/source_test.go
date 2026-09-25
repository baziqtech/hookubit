package ingest

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestClientAddress pins the hop arithmetic. Both failure modes it guards
// against have been shipped by this platform's control plane:
//
//   - trusting X-Forwarded-For blindly lets a client mint a fresh bucket per
//     request, which is worse than no limit because it looks like one;
//   - ignoring a real proxy collapses every client into one bucket, so a
//     trickle of anonymous traffic throttles every real customer.
func TestClientAddress(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		forwarded  []string
		hops       int
		want       string
	}{
		{
			name:       "no proxy configured ignores the header entirely",
			remoteAddr: "203.0.113.9:51234",
			forwarded:  []string{"198.51.100.1"},
			hops:       0,
			want:       "ip:203.0.113.9",
		},
		{
			name:       "a forged header cannot mint a bucket when hops is 0",
			remoteAddr: "203.0.113.9:51234",
			forwarded:  []string{"1.2.3.4, 5.6.7.8, 9.10.11.12"},
			hops:       0,
			want:       "ip:203.0.113.9",
		},
		{
			name:       "one proxy takes the entry just beyond it",
			remoteAddr: "10.0.0.5:40000", // the ingress pod
			forwarded:  []string{"198.51.100.7"},
			hops:       1,
			want:       "ip:198.51.100.7",
		},
		{
			name:       "a forged prefix is never reached at the configured hop count",
			remoteAddr: "10.0.0.5:40000",
			forwarded:  []string{"9.9.9.9, 8.8.8.8, 198.51.100.7"},
			hops:       1,
			want:       "ip:198.51.100.7",
		},
		{
			name:       "two proxies walk one further left",
			remoteAddr: "10.0.0.5:40000",
			forwarded:  []string{"203.0.113.4, 198.51.100.7"},
			hops:       2,
			want:       "ip:203.0.113.4",
		},
		{
			name:       "repeated X-Forwarded-For headers are one chain",
			remoteAddr: "10.0.0.5:40000",
			forwarded:  []string{"203.0.113.4", "198.51.100.7"},
			hops:       1,
			want:       "ip:198.51.100.7",
		},
		{
			name:       "a hop count longer than the chain clamps rather than reading past it",
			remoteAddr: "10.0.0.5:40000",
			forwarded:  []string{"198.51.100.7"},
			hops:       9,
			want:       "ip:198.51.100.7",
		},
		{
			name:       "a hop count with no header at all falls back to the socket peer",
			remoteAddr: "10.0.0.5:40000",
			hops:       3,
			want:       "ip:10.0.0.5",
		},
		{
			name:       "a forwarded entry carrying a port is one bucket, not many",
			remoteAddr: "10.0.0.5:40000",
			forwarded:  []string{"198.51.100.7:33333"},
			hops:       1,
			want:       "ip:198.51.100.7",
		},
		{
			// A single customer is routinely handed a /64 or larger, so a
			// per-address bucket would let one host walk 2^64 fresh buckets:
			// unlimited requests, and an unbounded key space in the limiter.
			name:       "IPv6 is aggregated to a /64",
			remoteAddr: "[2001:db8:1:2:aaaa:bbbb:cccc:dddd]:443",
			hops:       0,
			want:       "ip6:2001:db8:1:2::/64",
		},
		{
			name:       "another address in the same /64 is the same bucket",
			remoteAddr: "[2001:db8:1:2:1111:2222:3333:4444]:443",
			hops:       0,
			want:       "ip6:2001:db8:1:2::/64",
		},
		{
			name:       "a different /64 is a different bucket",
			remoteAddr: "[2001:db8:1:3::1]:443",
			hops:       0,
			want:       "ip6:2001:db8:1:3::/64",
		},
		{
			name:       "an unparseable forwarded entry still produces a stable key",
			remoteAddr: "10.0.0.5:40000",
			forwarded:  []string{"not-an-address"},
			hops:       1,
			want:       "ip:not-an-address",
		},
		{
			name: "a request with no remote address at all does not panic",
			hops: 0,
			want: "ip:unknown",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/v1/projects/prj_x/events", nil)
			r.RemoteAddr = tc.remoteAddr
			r.Header.Del("X-Forwarded-For")
			for _, v := range tc.forwarded {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := ClientAddress(r, tc.hops); got != tc.want {
				t.Fatalf("ClientAddress = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSourceLimiterBurstThenRefuse(t *testing.T) {
	l := NewSourceLimiter(SourceLimits{Limit: 10, Window: time.Second, Burst: 10}, nil)
	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("ip:1.1.1.1"); !ok {
			t.Fatalf("request %d of the burst was refused", i+1)
		}
	}
	ok, wait := l.Allow("ip:1.1.1.1")
	if ok {
		t.Fatal("the pre-auth limit did not bite")
	}
	if wait <= 0 {
		t.Fatal("no retry hint on a pre-auth refusal")
	}
	if ok, _ := l.Allow("ip:2.2.2.2"); !ok {
		t.Fatal("one address exhausting its bucket refused a different address")
	}
}

// The penalty is what lets the ceiling be generous for honest traffic and tight
// against a key-spraying flood: an authenticated client pays one token, an
// attacker pays penalty+1 for the same request.
func TestAuthFailurePenaltyDrainsTheBucketFaster(t *testing.T) {
	limits := SourceLimits{Limit: 100, Window: time.Second, Burst: 100, Penalty: 19}

	honest := NewSourceLimiter(limits, nil)
	for i := 0; i < 100; i++ {
		if ok, _ := honest.Allow("ip:1.1.1.1"); !ok {
			t.Fatalf("honest request %d refused before the burst was spent", i+1)
		}
	}

	attacker := NewSourceLimiter(limits, nil)
	admitted := 0
	for i := 0; i < 100; i++ {
		ok, _ := attacker.Allow("ip:9.9.9.9")
		if !ok {
			break
		}
		admitted++
		attacker.Penalise("ip:9.9.9.9") // every one of these failed to authenticate
	}
	if admitted > 6 {
		t.Fatalf("a key-spraying client got %d database lookups out of the same bucket that gave an honest client 100; the penalty is not biting", admitted)
	}
}

// A disabled limiter must be a nil pointer that still answers, so the handler
// pays nothing for a switched-off feature and cannot panic on it.
func TestDisabledSourceLimiterIsNilAndAllows(t *testing.T) {
	var l *SourceLimiter
	if got := NewSourceLimiter(SourceLimits{Limit: 0, Window: time.Second}, nil); got != nil {
		t.Fatal("a limit of 0 must disable the limiter")
	}
	if ok, _ := l.Allow("ip:1.1.1.1"); !ok {
		t.Fatal("a nil limiter refused a request")
	}
	l.Penalise("ip:1.1.1.1") // must not panic
}
