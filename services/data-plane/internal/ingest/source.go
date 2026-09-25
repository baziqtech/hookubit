package ingest

import (
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/ratelimit"
)

// SourceLimiter is the PRE-AUTH ceiling: the only thing standing between an
// unauthenticated flood and the database.
//
// # Why this is separate from the policy limiter, and why it is in-process
//
// The attack it closes needs no credential. An attacker posts well-formed but
// bogus bearer tokens at POST /v1/projects/<any ULID>/events as fast as the
// network allows; each one reaches store.FindAPIKey, takes one of this pod's
// DATABASE_MAX_CONNECTIONS connections and holds it for up to
// INGEST_DB_TIMEOUT_MS. Around forty concurrent requests exhaust the pool, and
// every further request - including every legitimate one - blocks in Acquire.
// That is unauthenticated denial of the write path.
//
// So this bucket must hold BEFORE any credential is known, which rules out
// anything keyed on organisation, project or key. And it must hold when Redis
// is down, which rules out Redis: the policy limiter fails OPEN on a Redis
// fault by design, and a DoS defence that evaporates on a cache outage is not
// one. In-process is not a compromise here, it is the correct scope - the
// resource being protected, this pod's connection pool, is per-process too.
//
// The cost is that N replicas admit N x the limit before authenticating. That
// is fine: the ceiling exists to keep each pod's pool usable, and each pod
// enforcing it locally achieves exactly that.
type SourceLimiter struct {
	buckets  *ratelimit.Local
	capacity float64
	rate     float64
	// penalty is charged IN ADDITION to the normal token when a request fails
	// authentication.
	//
	// This is what lets the limit be generous enough not to bother real
	// traffic while still being tight against the attack. A legitimate client
	// pays one token per request; an attacker spraying invalid keys pays
	// penalty+1, draining the same bucket an order of magnitude faster. The
	// limit can then be set for the honest case rather than the hostile one.
	penalty float64
}

// SourceLimits configures SourceLimiter. Limit <= 0 disables it entirely.
type SourceLimits struct {
	Limit   int
	Window  time.Duration
	Burst   int
	Penalty int
}

// NewSourceLimiter returns nil when the limit is disabled, so the handler pays
// nothing for a feature that is switched off.
func NewSourceLimiter(limits SourceLimits, now func() time.Time) *SourceLimiter {
	if limits.Limit <= 0 || limits.Window <= 0 {
		return nil
	}
	capacity := float64(limits.Limit)
	if limits.Burst > limits.Limit {
		capacity = float64(limits.Burst)
	}
	penalty := float64(limits.Penalty)
	if penalty < 0 {
		penalty = 0
	}
	return &SourceLimiter{
		buckets:  ratelimit.NewLocal(now, 0),
		capacity: capacity,
		rate:     float64(limits.Limit) / limits.Window.Seconds(),
		penalty:  penalty,
	}
}

// Allow charges one token to this address.
func (s *SourceLimiter) Allow(addr string) (bool, time.Duration) {
	if s == nil {
		return true, 0
	}
	return s.buckets.Allow(addr, s.capacity, s.rate, 1)
}

// Penalise charges the extra cost of a request that failed authentication. Its
// answer is discarded: the request is already being refused, and the point is
// the debt left behind for the NEXT one.
func (s *SourceLimiter) Penalise(addr string) {
	if s == nil || s.penalty <= 0 {
		return
	}
	s.buckets.Allow(addr, s.capacity, s.rate, s.penalty)
}

// ClientAddress derives the address a request is charged to.
//
// `hops` is the number of proxies between this process and the internet, and it
// is EXACT, from configuration - never inferred, never `trust everything`. The
// control plane hit both failure modes of getting this wrong and the same two
// apply here:
//
//   - Trusting X-Forwarded-For blindly (walking to the left-most entry) lets a
//     client send `X-Forwarded-For: <random>` and mint a fresh bucket per
//     request. That is WORSE than no rate limiting, because it looks like there
//     is some.
//   - Ignoring a real proxy collapses every client onto the proxy's address, so
//     the whole platform shares one bucket and a trickle of anonymous traffic
//     locks everyone out.
//
// With hops = 0 (the default) the forwarded header is not read at all and the
// socket peer is used. With hops = n, the n addresses nearest this process are
// trusted and the address just beyond them is taken; a client-supplied prefix
// is never reached. An n larger than the chain clamps to the left-most entry
// rather than reading past it.
func ClientAddress(r *http.Request, hops int) string {
	return bucketKey(ClientIP(r, hops))
}

// ClientIP is the same hop selection as ClientAddress, but returns the address
// ITSELF rather than a rate-limit bucket key.
//
// The two must not be conflated. `bucketKey` deliberately widens an IPv6
// address to its /64 network, because a rate limit that treated every address
// in a customer's /64 as a separate client would limit nothing. An allowlist
// that compared against that widened form would match every address in a /64
// against an entry naming one of them — silently turning `2001:db8::1` into
// `2001:db8::/64`, which is 18 quintillion addresses the operator did not
// permit. So the allowlist gets the address and the limiter gets the bucket.
func ClientIP(r *http.Request, hops int) string {
	peer := hostOnly(r.RemoteAddr)
	if hops <= 0 {
		return peer
	}

	// The chain runs left (furthest from us) to right (nearest). The socket
	// peer is the rightmost hop and is the only entry we know to be real.
	forwarded := r.Header.Values("X-Forwarded-For")
	var chain []string
	for _, header := range forwarded {
		for _, part := range strings.Split(header, ",") {
			if v := strings.TrimSpace(part); v != "" {
				chain = append(chain, v)
			}
		}
	}
	chain = append(chain, peer)

	idx := len(chain) - 1 - hops
	if idx < 0 {
		idx = 0
	}
	return hostOnly(chain[idx])
}

// hostOnly strips a port and IPv6 brackets. A forwarded entry may legitimately
// carry a port, and `1.2.3.4:1111` and `1.2.3.4:2222` must be one bucket, not
// two.
func hostOnly(addr string) string {
	if addr == "" {
		return "unknown"
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		addr = host
	}
	addr = strings.TrimPrefix(strings.TrimSuffix(addr, "]"), "[")
	if addr == "" {
		return "unknown"
	}
	return addr
}

// bucketKey aggregates IPv6 to a /64.
//
// A single IPv6 customer is routinely handed a /64 or larger, so a per-address
// bucket would let one host cycle through 2^64 fresh buckets - unlimited
// requests, and an unbounded key space in the limiter's map. /64 is the
// smallest block an end site is assigned, so it is the finest granularity that
// still means "one origin". IPv4 is used whole.
func bucketKey(host string) string {
	ip := net.ParseIP(host)
	if ip == nil {
		return "ip:" + host
	}
	if v4 := ip.To4(); v4 != nil {
		return "ip:" + v4.String()
	}
	masked := ip.Mask(net.CIDRMask(64, 128))
	return "ip6:" + masked.String() + "/64"
}
