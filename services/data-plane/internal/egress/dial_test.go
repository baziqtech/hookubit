package egress

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
)

// blockedCount reads one series of egress_blocked_total. Calling it also
// materialises that series, which the assertions below rely on.
func blockedCount(t *testing.T, code string) float64 {
	t.Helper()
	var m dto.Metric
	if err := metrics.EgressBlocked.WithLabelValues(code).Write(&m); err != nil {
		t.Fatalf("read egress_blocked_total{reason=%q}: %v", code, err)
	}
	return m.GetCounter().GetValue()
}

// seriesCount is how many time series a collector is currently exporting. It is
// the cardinality assertion: a label fed from customer input makes this grow
// without bound.
func seriesCount(t *testing.T, c prometheus.Collector) int {
	t.Helper()
	ch := make(chan prometheus.Metric, 4096)
	go func() {
		c.Collect(ch)
		close(ch)
	}()
	n := 0
	for range ch {
		n++
	}
	return n
}

// blackholeResolver returns a resolver whose every query goes to a socket that
// accepts the connection and then says nothing, for as long as the caller is
// willing to wait. That is the failure EGRESS_DNS_TIMEOUT_MS exists for: not a
// nameserver that is down (which answers fast, with a refusal) but one that has
// stopped answering.
func blackholeResolver(t *testing.T) *net.Resolver {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var (
		mu    sync.Mutex
		conns []net.Conn
	)
	// Registered up front, not from the accept goroutine: t.Cleanup panics if it
	// is called after the test has finished, and a query can still land while
	// the test is tearing down.
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
	})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			// Hold it open. Never answer, never close.
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
		}
	}()
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", ln.Addr().String())
		},
	}
}

// EGRESS_DNS_TIMEOUT_MS used to be a control that lied: Limits.DNSTimeout was
// defined, plumbed through config and shipped in both ConfigMaps, and NewClient
// never read it. Resolution was bounded only by ConnectTimeout, SHARED with the
// TCP connect - so an operator setting DNS_TIMEOUT=200ms to shed slow lookups
// changed nothing, and one unresponsive nameserver could hold a worker slot for
// the entire connect budget.
//
// This asserts the fix at the only place it is observable: the wall clock.
func TestDNSTimeoutBoundsResolutionIndependentlyOfConnectTimeout(t *testing.T) {
	limits := DefaultLimits()
	limits.DNSTimeout = 150 * time.Millisecond
	// Deliberately far apart. If resolution were still governed by the connect
	// budget, this test would take five seconds rather than a fifth of one.
	limits.ConnectTimeout = 5 * time.Second
	limits.TotalTimeout = 20 * time.Second

	client := newClient(newTestGuard(t), limits, blackholeResolver(t))

	started := time.Now()
	_, err := client.Do(context.Background(), http.MethodPost,
		"http://slow-resolver.endpoint.invalid/hook", nil, []byte(`{}`))
	elapsed := time.Since(started)

	if err == nil {
		t.Fatal("a delivery whose nameserver never answered succeeded")
	}
	if elapsed >= limits.ConnectTimeout {
		t.Fatalf("resolution took %v, which is the CONNECT budget (%v), not the DNS one (%v): "+
			"EGRESS_DNS_TIMEOUT_MS is still not wired to anything", elapsed, limits.ConnectTimeout, limits.DNSTimeout)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("resolution took %v, want it bounded near DNSTimeout (%v)", elapsed, limits.DNSTimeout)
	}

	// The TYPE is load-bearing. worker.ErrorCode and retry.ShouldRetry classify
	// a failed lookup by asking whether the error is a *net.DNSError; wrapping
	// it in anything else silently reclassifies every DNS failure in the
	// platform, and a resolver that is briefly unreachable would start burning
	// customers' events instead of being retried.
	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) {
		t.Fatalf("error is %T (%v), want a *net.DNSError", err, err)
	}
	if !dnsErr.IsTimeout {
		t.Fatalf("DNSError.IsTimeout = false for a nameserver that never answered (%v); the worker "+
			"records this as a permanent-looking failure rather than a timeout", dnsErr)
	}
	// And it must NOT look like a policy refusal: nothing was judged here, the
	// answer simply never came, and a retry may well get one.
	var blocked *BlockedTargetError
	if errors.As(err, &blocked) {
		t.Fatal("a DNS timeout was reported as an egress policy refusal, which package retry treats as permanent")
	}
}

// The DNS timeout is implemented by resolving and then dialling each address as
// a literal. That is only safe while every address still passes through
// Dialer.Control - the single point where an address is judged. This asserts it
// with the DNS-bounded path active, at the level the guarantee is actually
// stated: the refusal names the resolved ADDRESS, not the hostname.
func TestBoundedResolutionStillJudgesEveryResolvedAddress(t *testing.T) {
	// A listener on loopback that must never be reached.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			select {
			case accepted <- struct{}{}:
			default:
			}
			_ = conn.Close()
		}
	}()
	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	limits := DefaultLimits()
	limits.DNSTimeout = 2 * time.Second
	client := newClient(newTestGuard(t), limits, &net.Resolver{PreferGo: true})

	before := blockedCount(t, CodeLoopback)

	// "localhost" is the interesting spelling: nothing about the string betrays
	// it, only the addresses it resolves to.
	_, err = client.Do(context.Background(), http.MethodPost, "http://localhost:"+port+"/hook", nil, []byte(`{}`))
	if err == nil {
		t.Fatal("a hostname resolving to loopback was delivered to; the SSRF guard is not on the bounded-DNS path")
	}
	var blocked *BlockedTargetError
	if !errors.As(err, &blocked) {
		t.Fatalf("error is %T (%v), want *BlockedTargetError", err, err)
	}
	if net.ParseIP(blocked.Target) == nil {
		t.Fatalf("refusal named %q rather than a resolved address: the judgement was not made on what was "+
			"about to be dialled", blocked.Target)
	}
	if blocked.Code != CodeLoopback {
		t.Fatalf("Code = %q, want %q", blocked.Code, CodeLoopback)
	}
	select {
	case <-accepted:
		t.Fatal("the loopback listener accepted a connection: the address was judged AFTER the socket was opened")
	default:
	}

	if after := blockedCount(t, CodeLoopback); after <= before {
		t.Fatalf("egress_blocked_total{reason=%q} did not move (%v -> %v); an SSRF refusal that increments "+
			"no counter is a refusal no operator can see", CodeLoopback, before, after)
	}
}

// egress_blocked_total was declared and never written, so SSRF refusals had no
// counter at all. This asserts that they now do - and, just as importantly,
// that the label is the closed vocabulary rather than the human-readable
// Reason, which interpolates whatever a customer typed into the endpoint form.
func TestBlockedRefusalsAreCountedUnderABoundedLabel(t *testing.T) {
	g := newTestGuard(t)

	// Read first, so the series exists before the count is taken: what is being
	// asserted is that three DIFFERENT schemes add no further series.
	before := blockedCount(t, CodeScheme)
	seriesBefore := seriesCount(t, metrics.EgressBlocked)

	// Three different schemes: three refusals, ONE series. Labelling by Reason
	// ("scheme gopher is not permitted") would make this three, and a tenant
	// with a script could then mint series until the metrics backend fell over.
	for _, raw := range []string{"gopher://evil.example/", "ftp://evil.example/", "file:///etc/passwd"} {
		if _, err := g.CheckURL(raw); err == nil {
			t.Fatalf("CheckURL(%q) was allowed", raw)
		}
	}

	if after := blockedCount(t, CodeScheme); after != before+3 {
		t.Fatalf("egress_blocked_total{reason=%q} = %v, want %v", CodeScheme, after, before+3)
	}
	if seriesAfter := seriesCount(t, metrics.EgressBlocked); seriesAfter != seriesBefore {
		t.Fatalf("three refused schemes created %d new time series, want 0: the counter is labelled by "+
			"something customer-supplied", seriesAfter-seriesBefore)
	}

	// A metadata refusal is its own code, so "someone is probing IMDS" is a
	// query rather than a grep through delivery_attempts.
	beforeMeta := blockedCount(t, CodeMetadata)
	if _, err := g.CheckURL("http://169.254.169.254/latest/meta-data/iam/security-credentials/"); err == nil {
		t.Fatal("the metadata URL was allowed")
	}
	if after := blockedCount(t, CodeMetadata); after != beforeMeta+1 {
		t.Fatalf("egress_blocked_total{reason=%q} = %v, want %v", CodeMetadata, after, beforeMeta+1)
	}
}

// One refusal must be one increment. CheckIP recurses through itself to judge
// the IPv4 address embedded in a NAT64/6to4 literal, so counting inside CheckIP
// would report a single refused destination twice and quietly double every
// transition-address rate on the dashboard.
func TestATransitionRefusalIsCountedOnce(t *testing.T) {
	g := newTestGuard(t)
	before := blockedCount(t, CodeTransition)
	beforeMeta := blockedCount(t, CodeMetadata)

	// NAT64 wrapping 169.254.169.254.
	if _, err := g.CheckURL("http://[64:ff9b::a9fe:a9fe]/latest/meta-data/"); err == nil {
		t.Fatal("a NAT64 route to the metadata service was allowed")
	}

	if after := blockedCount(t, CodeTransition); after != before+1 {
		t.Fatalf("transition refusals moved by %v, want 1", after-before)
	}
	if after := blockedCount(t, CodeMetadata); after != beforeMeta {
		t.Fatalf("the inner CheckIP also counted (%v -> %v): one refused destination is being reported twice",
			beforeMeta, after)
	}
}

// A literal address needs no lookup, so it must not be given a lookup: the
// bounded path has to leave IP literals alone, or every delivery to an endpoint
// written as an IP would pay for a resolution that answers itself.
func TestLiteralAddressesSkipResolutionEntirely(t *testing.T) {
	limits := DefaultLimits()
	// A resolver that would hang for a minute if anything asked it anything.
	limits.DNSTimeout = time.Minute
	client := newClient(mustAllowPrivate(t), limits, blackholeResolver(t))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()

		// Drain the request before answering. The client POSTs a body; closing
		// with unread bytes still in the receive buffer makes the close an RST
		// rather than a FIN, and the client then reports "connection reset by
		// peer" instead of reading the 204 that was already on the wire. That
		// is timing-dependent, so it shows up as a flake under load rather than
		// as a bug - this test failed exactly that way on a box at load average
		// 15.7.
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		br := bufio.NewReader(conn)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		// ReadRequest parses the headers and leaves the body; the body is what
		// would still be sitting unread at close.
		_, _ = io.Copy(io.Discard, req.Body)
		_ = req.Body.Close()
		_, _ = conn.Write([]byte("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := client.Do(ctx, http.MethodPost, "http://"+ln.Addr().String()+"/hook", nil, []byte(`{}`))
	if err != nil {
		if strings.Contains(err.Error(), "context deadline exceeded") {
			t.Fatalf("a request to an IP literal was made to wait on the resolver: %v", err)
		}
		t.Fatalf("request to an IP literal failed: %v", err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
}

func mustAllowPrivate(t *testing.T) *Guard {
	t.Helper()
	g, err := NewGuard(true, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}
	return g
}

// A name whose first address black-holes must not consume the whole connect
// budget and strand the addresses behind it.
//
// The regression this pins: the connect phase used ONE deadline shared across a
// serial loop over every resolved address. `localhost` resolves to [::1,
// ::ffff:127.0.0.1] here — LookupNetIP applies RFC 6724, so the v6 address
// sorts first — which is precisely the shape of a dual-stack node with a
// filtered v6 path. With one shared deadline, ::1 spent all 3s and 127.0.0.1
// was then dialled on an already-expired context: an endpoint that is up, and
// every delivery to it failing with a timeout.
//
// The black hole is simulated with ControlContext blocking until its deadline,
// which is what a dropped SYN looks like to the dialer — not a refusal, which
// would return immediately and prove nothing.
func TestABlackHoledAddressDoesNotStarveTheNextOne(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no IPv4 loopback listener available: %v", err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()

	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split listener address: %v", err)
	}

	// Confirm the precondition rather than assuming it: on a host where
	// localhost has a single address this test proves nothing.
	addrs, err := (&net.Resolver{PreferGo: true}).LookupNetIP(context.Background(), "ip", "localhost")
	if err != nil || len(addrs) < 2 {
		t.Skipf("localhost does not resolve to multiple addresses here (%v, %v)", addrs, err)
	}
	if !addrs[0].Is6() || addrs[0].Is4In6() {
		t.Skipf("localhost does not sort a v6 address first here (%v)", addrs)
	}

	var blackHoled atomic.Int32
	const connectTimeout = 3 * time.Second

	d := &boundedDialer{
		dialer: &net.Dialer{
			ControlContext: func(ctx context.Context, _, address string, _ syscall.RawConn) error {
				if strings.HasPrefix(address, "[::1]") {
					blackHoled.Add(1)
					<-ctx.Done()
					return ctx.Err()
				}
				return nil
			},
		},
		resolver:       &net.Resolver{PreferGo: true},
		dnsTimeout:     time.Second,
		connectTimeout: connectTimeout,
	}

	start := time.Now()
	conn, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("localhost", port))
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("dial failed after %v with %v; the second address was reachable the whole time", elapsed, err)
	}
	_ = conn.Close()

	if blackHoled.Load() == 0 {
		t.Fatal("the v6 address was never dialled, so this run did not exercise the starvation path")
	}
	if elapsed >= connectTimeout {
		t.Fatalf("took %v, which is the whole connect budget: the first address was not bounded to a share of it", elapsed)
	}
}

// partialDeadline divides what is left, and refuses to divide it into slices
// too short to complete a handshake.
func TestPartialDeadlineDividesTheRemainingBudget(t *testing.T) {
	now := time.Now()

	// Evenly divisible and comfortably above the floor.
	got, err := partialDeadline(now, now.Add(20*time.Second), 4)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if share := got.Sub(now); share != 5*time.Second {
		t.Fatalf("share = %v, want 5s", share)
	}

	// Below the two-second floor: earlier addresses get a usable slice even
	// though that means later ones may get none.
	got, err = partialDeadline(now, now.Add(3*time.Second), 4)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if share := got.Sub(now); share != 2*time.Second {
		t.Fatalf("share = %v, want the 2s floor", share)
	}

	// Less than the floor remaining in total: take what is left, do not
	// manufacture budget that does not exist.
	got, err = partialDeadline(now, now.Add(900*time.Millisecond), 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if share := got.Sub(now); share != 900*time.Millisecond {
		t.Fatalf("share = %v, want the whole 900ms remainder", share)
	}

	// Already spent.
	if _, err := partialDeadline(now, now.Add(-time.Second), 2); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("err = %v, want os.ErrDeadlineExceeded", err)
	}
}
