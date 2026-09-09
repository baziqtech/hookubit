package outage_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/egress"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
	"github.com/shaq/webhook-platform/services/data-plane/internal/worker"
)

// countingListener is a real TCP listener that records every connection it
// accepts. It is how these tests prove "before any bytes are sent": the
// assertion is not that an error came back, it is that the socket was never
// opened.
type countingListener struct {
	ln       net.Listener
	accepted atomic.Int64
}

func newCountingListener(t *testing.T) *countingListener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	c := &countingListener{ln: ln}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			c.accepted.Add(1)
			_ = conn.Close()
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return c
}

func (c *countingListener) addr() string { return c.ln.Addr().String() }
func (c *countingListener) count() int64 { return c.accepted.Load() }
func (c *countingListener) port() string { _, p, _ := net.SplitHostPort(c.addr()); return p }
func (c *countingListener) url() string  { return "http://" + c.addr() + "/hook" }

// TestScenario13_DNSResolutionFails_IsRecordedAndRetried covers
// ARCHITECTURE.md 57 scenario 13: DNS resolution fails.
//
// Recovery strategy asserted: a name that does not resolve is a TRANSIENT
// failure. It is recorded as a delivery attempt with the `dns` error code -
// DETERMINISTICALLY, whether the lookup returned NXDOMAIN or timed out - the
// delivery moves to `retrying` with a future next_attempt_at, and it is not
// marked permanently failed on the first miss: a customer's DNS being briefly
// broken (a propagation window, a registrar blip, a nameserver restart) must
// not burn their events.
//
// A production regression would look like: a DNS miss classified alongside the
// structurally-permanent failures (a blocked target, an unbuildable request),
// so the first attempt terminates the delivery; or an attempt that fails
// without writing a delivery_attempts row, leaving an operator with a delivery
// that "just stopped" and no evidence of why.
func TestScenario13_DNSResolutionFails_IsRecordedAndRetried(t *testing.T) {
	client := egress.NewClient(mustGuard(t, false, nil), egress.DefaultLimits())

	// .invalid is reserved by RFC 6761 and is guaranteed never to resolve, so
	// this test needs no network and cannot be broken by a wildcard DNS
	// provider.
	token, err := ids.Token(6)
	if err != nil {
		t.Fatal(err)
	}
	target := "http://" + token + ".endpoint.invalid/hook"

	started := time.Now()
	_, doErr := client.Do(context.Background(), http.MethodPost, target, nil, []byte(`{"a":1}`))
	elapsed := time.Since(started)
	if doErr == nil {
		t.Fatal("delivery to a name that cannot resolve succeeded")
	}

	var dnsErr *net.DNSError
	if !errors.As(doErr, &dnsErr) {
		t.Fatalf("error is %T (%v), want a *net.DNSError; the classification below reads the error's TYPE, "+
			"so anything else silently reclassifies every DNS failure", doErr, doErr)
	}

	// Classification. These three are what decide the delivery's fate, and all
	// three must agree that this is worth another go.
	if retry.IsBlockedTarget(doErr) {
		t.Fatal("a DNS failure was classified as an egress policy rejection, which is permanent")
	}
	if retry.IsPermanentError(doErr) {
		t.Fatal("a DNS failure was marked permanent; a name that does not resolve now may resolve in a minute")
	}
	if !retry.ShouldRetry(0, doErr) {
		t.Fatal("retry.ShouldRetry says a DNS failure is not worth retrying: the first propagation blip " +
			"would destroy a customer's events")
	}
	// What the ledger records is now the SAME whichever way the lookup failed,
	// and that is the fix. A DNS failure arrives in two shapes - an NXDOMAIN,
	// which is a *net.DNSError that is not a timeout, and an unresponsive
	// nameserver, which is one that is - and which of the two this test sees
	// varies run to run with the local resolver.
	//
	// worker.ErrorCode used to ask isTimeout() BEFORE it asked "is this a DNS
	// error", so the second (and commoner) case was recorded as `timeout`: the
	// same code an endpoint that accepted the connection and then went silent
	// produces. Nothing was lost or wrongly failed - both are retried
	// identically - but an operator could not tell "their nameserver is down"
	// from "their server is slow", which is the question the delivery ledger
	// exists to answer.
	//
	// The assertion is now UNCONDITIONAL, and that determinism is the point: it
	// no longer adapts to however the resolver happened to fail.
	const wantCode = "dns"
	const wantStatus = worker.AttemptError
	if code := worker.ErrorCode(0, doErr); code != wantCode {
		t.Fatalf("worker.ErrorCode = %q, want %q for a DNS failure (Timeout()=%v); a DNS error must be "+
			"named as one whether or not it timed out, or an operator cannot tell a broken nameserver "+
			"from a slow server", code, wantCode, dnsErr.IsTimeout)
	}

	// The state machine, on the FIRST attempt of a policy with budget left.
	policy := retry.DefaultPolicy()
	now := time.Now()
	decision := worker.Decide(worker.DecisionInput{
		Attempt:        1,
		Policy:         policy,
		FirstAttemptAt: now,
		Now:            now,
		Outcome:        worker.Outcome{Err: doErr},
	}, nil)
	if decision.State != worker.StateRetrying {
		t.Fatalf("state after one DNS failure = %q, want %q", decision.State, worker.StateRetrying)
	}
	if decision.Reason != worker.ReasonRetryScheduled {
		t.Fatalf("reason = %q, want %q", decision.Reason, worker.ReasonRetryScheduled)
	}
	if decision.AttemptStatus != wantStatus {
		t.Fatalf("attempt status = %q, want %q: `timeout` is reserved for an endpoint that accepted the "+
			"connection and then went silent, and a name that never resolved is not that",
			decision.AttemptStatus, wantStatus)
	}
	if !decision.NextAttemptAt.After(now) {
		t.Fatalf("next_attempt_at = %v, want a time after %v: a retry scheduled in the past is a hot loop",
			decision.NextAttemptAt, now)
	}

	// Bounded. The dialer's timeout covers resolution as well as connect, so a
	// resolver that is slow rather than absent cannot hold a worker slot
	// indefinitely.
	if elapsed > 3*egress.DefaultLimits().TotalTimeout {
		t.Fatalf("a DNS failure took %v; resolution is not bounded by the egress limits", elapsed)
	}

	// And the ledger. This is the half that answers the operator's question, so
	// it is asserted against the real table through the real store.
	truth := directPool(t)
	seed := seedTenant(t, truth)
	const workerID = "worker_dns"
	deliveryID := seed.insertDelivery(t, "processing", workerID, time.Minute)

	store := worker.NewPostgresStore(truth)
	attemptStart := time.Now().Add(-2 * time.Second)
	err = store.Complete(context.Background(), workerID, deliveryID, &worker.AttemptRecord{
		Number:       1,
		StartedAt:    attemptStart,
		CompletedAt:  time.Now(),
		Status:       decision.AttemptStatus,
		ErrorCode:    worker.ErrorCode(0, doErr),
		ErrorMessage: doErr.Error(),
		Duration:     elapsed,
		WorkerID:     workerID,
	}, worker.Transition{
		State:  decision.State,
		Reason: decision.Reason,
		// The delay the POLICY chose, not time.Until(NextAttemptAt).
		//
		// NextAttemptAt is `now` plus the policy delay, and `now` was captured
		// before the database setup above. Recomputing from it makes the
		// recorded delay shrink by however long that setup took - and under a
		// loaded machine that setup has exceeded the delay, making it negative,
		// writing next_attempt_at into the past and failing the assertion below
		// for a reason that has nothing to do with DNS. The scheduled delay is a
		// property of the decision, so take it from the decision.
		Delay:        decision.NextAttemptAt.Sub(now),
		AttemptCount: 1,
	})
	if err != nil {
		t.Fatalf("record the DNS attempt: %v", err)
	}

	var (
		attemptStatus string
		errorCode     string
	)
	if err := truth.QueryRow(context.Background(),
		`SELECT status::text, COALESCE(error_code, '') FROM delivery_attempts WHERE delivery_id = $1`,
		deliveryID).Scan(&attemptStatus, &errorCode); err != nil {
		t.Fatalf("read back the attempt row: %v", err)
	}
	if attemptStatus != string(wantStatus) || errorCode != wantCode {
		t.Fatalf("delivery_attempts row = (%s, %s), want (%s, %s)", attemptStatus, errorCode, wantStatus, wantCode)
	}

	var (
		deliveryStatus string
		future         bool
	)
	if err := truth.QueryRow(context.Background(),
		`SELECT status::text, next_attempt_at > now() FROM deliveries WHERE id = $1`,
		deliveryID).Scan(&deliveryStatus, &future); err != nil {
		t.Fatalf("read back the delivery: %v", err)
	}
	if deliveryStatus != string(worker.StateRetrying) {
		t.Fatalf("delivery status = %q after one DNS miss, want %q: a single failed lookup ended the "+
			"delivery", deliveryStatus, worker.StateRetrying)
	}
	if !future {
		t.Fatal("next_attempt_at is not in the future; the delivery would be re-claimed immediately and " +
			"hammer a resolver that is already struggling")
	}
}

// TestScenario14_DNSResolvesToPrivateIP_NothingIsDialled covers
// ARCHITECTURE.md 57 scenario 14: a customer's hostname resolves into private
// space.
//
// internal/egress already proves the refusal itself
// (TestHostnameResolvingToLoopbackIsRefusedAtDialTime). What that test does not
// prove, and what the scenario actually asks for, is that the refusal happens
// BEFORE any bytes are sent: this one puts a real listener behind the private
// address and asserts it never accepted a connection.
//
// A production regression would look like: the check moving from
// net.Dialer.Control to somewhere after the connection is established - the
// error would still come back, every test asserting only the error would still
// pass, and the internal service would still have received a request.
func TestScenario14_DNSResolvesToPrivateIP_NothingIsDialled(t *testing.T) {
	listener := newCountingListener(t)
	client := egress.NewClient(mustGuard(t, false, nil), egress.DefaultLimits())

	// "localhost" is the interesting spelling: it is not an IP literal, so
	// nothing about the URL string betrays it. Only the resolved address does.
	target := "http://localhost:" + listener.port() + "/hook"

	_, err := client.Do(context.Background(), http.MethodPost, target, nil, []byte(`{"a":1}`))
	if err == nil {
		t.Fatal("delivery to a hostname resolving into private space succeeded")
	}

	var blocked *egress.BlockedTargetError
	if !errors.As(err, &blocked) {
		t.Fatalf("error is %T (%v), want a *egress.BlockedTargetError", err, err)
	}
	// The refusal names the ADDRESS, not the name. That is the evidence that
	// the judgement was made on what was about to be dialled.
	if net.ParseIP(blocked.Target) == nil {
		t.Fatalf("BlockedTargetError.Target = %q, want the resolved IP: a refusal keyed on the hostname "+
			"means something other than the dialled address was judged", blocked.Target)
	}
	if n := listener.count(); n != 0 {
		t.Fatalf("the private listener accepted %d connections: the SSRF guard refused the request only "+
			"AFTER the internal service had already been reached", n)
	}

	// Permanent, because the same URL resolves the same way forever, and a
	// 24-hour retry budget spent re-proving it is worse than useless.
	if retry.ShouldRetry(0, err) {
		t.Fatal("a blocked target is being retried; every retry is another connection attempt at an " +
			"internal address")
	}
	decision := worker.Decide(worker.DecisionInput{
		Attempt: 1, Policy: retry.DefaultPolicy(), Now: time.Now(),
		Outcome: worker.Outcome{Err: err},
	}, nil)
	if decision.State != worker.StateFailed || decision.Reason != worker.ReasonBlockedTarget {
		t.Fatalf("decision = (%s, %s), want (failed, blocked_target)", decision.State, decision.Reason)
	}
}

// TestScenario15_RedirectToPrivateIP_IsNotFollowedUnderShippedDefaults covers
// ARCHITECTURE.md 57 scenario 15: an endpoint redirects into private space.
//
// internal/egress already proves the re-validation when redirects are enabled
// (TestRedirectToPrivateAddressIsNotFollowed, which sets MaxRedirects=3 and
// points the redirect at 169.254.169.254). This test asserts the layer in front
// of it: EGRESS_MAX_REDIRECTS defaults to 0, so under the SHIPPED configuration
// a redirect is not followed AT ALL - not to private space, not anywhere - and
// the redirect target is never contacted.
//
// A production regression would look like: the default flipping to a non-zero
// value, or CheckRedirect being dropped in favour of http.Client's default
// (which follows up to ten redirects with no validation whatsoever).
func TestScenario15_RedirectToPrivateIP_IsNotFollowedUnderShippedDefaults(t *testing.T) {
	// The redirect target: a real listener that must never be contacted.
	victim := newCountingListener(t)

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, victim.url(), http.StatusFound)
	}))
	defer redirector.Close()

	// AllowPrivateNetworks, so that loopback is NOT what refuses this: the only
	// thing standing between the redirect and the victim is the redirect policy
	// itself.
	limits := egress.DefaultLimits()
	if limits.MaxRedirects != 0 {
		t.Fatalf("egress.DefaultLimits().MaxRedirects = %d, want 0 to match EGRESS_MAX_REDIRECTS's default",
			limits.MaxRedirects)
	}
	client := egress.NewClient(mustGuard(t, true, nil), limits)

	resp, err := client.Do(context.Background(), http.MethodPost, redirector.URL, nil, []byte(`{"a":1}`))
	if err == nil {
		t.Fatalf("the redirect was followed and returned %d", resp.StatusCode)
	}
	var blocked *egress.BlockedTargetError
	if !errors.As(err, &blocked) {
		t.Fatalf("error is %T (%v), want a *egress.BlockedTargetError so package retry can see it is "+
			"permanent", err, err)
	}
	if retry.ShouldRetry(0, err) {
		t.Fatal("a refused redirect is being retried; the endpoint will answer with the same 302 forever")
	}
	if n := victim.count(); n != 0 {
		t.Fatalf("the redirect target accepted %d connections despite EGRESS_MAX_REDIRECTS=0", n)
	}
}

// TestScenario16_DNSRebinding_TheDialledAddressIsTheJudgedOne covers
// ARCHITECTURE.md 57 scenario 16: DNS changes after the initial validation.
//
// The reason this platform is not vulnerable is structural rather than clever:
// there is no "initial validation" of a resolved address to diverge from.
// egress.Guard.CheckURL performs NO name resolution - it judges only a literal
// IP - and the authoritative check runs in net.Dialer.Control, which the
// runtime calls once per resolved address, after resolution and immediately
// before connect. A rebind between the two therefore has no window to land in:
// whatever the name resolves to at dial time is the value that is judged.
//
// This test asserts that property in the only way that distinguishes it from
// "the URL string looked fine": the same client is pointed at the same
// hostname twice, at a host whose address is judged only at dial time, and the
// refusal each time names the concrete address rather than the name. It also
// pins the shape the defence depends on - a public-looking name is accepted by
// CheckURL and stopped later - because a "fix" that moved the check to a
// pre-flight lookup would keep every existing test passing and reopen the hole.
//
// A production regression would look like: someone replacing Dialer.Control
// with a resolve-then-validate-then-dial sequence (or caching a validated IP
// per hostname), which reintroduces exactly the TOCTOU window this design
// avoids.
func TestScenario16_DNSRebinding_TheDialledAddressIsTheJudgedOne(t *testing.T) {
	guard := mustGuard(t, false, nil)

	// 1. A hostname is NOT judged by CheckURL. This is the pre-condition of the
	//    whole design: if CheckURL resolved names, its answer would be the
	//    stale one a rebind attacks.
	if _, err := guard.CheckURL("http://localhost:1/hook"); err != nil {
		t.Fatalf("CheckURL rejected a hostname before resolution (%v). That is not safer: it means a name "+
			"is being resolved and judged somewhere other than at dial time, which is the window DNS "+
			"rebinding needs", err)
	}
	// A literal, by contrast, is judged immediately - the cheap first filter.
	if _, err := guard.CheckURL("http://127.0.0.1:1/hook"); err == nil {
		t.Fatal("CheckURL accepted a loopback IP literal")
	}

	// 2. The dial-time check is per address and names the address.
	listener := newCountingListener(t)
	client := egress.NewClient(guard, egress.DefaultLimits())
	target := "http://localhost:" + listener.port() + "/hook"

	for attempt := 1; attempt <= 2; attempt++ {
		_, err := client.Do(context.Background(), http.MethodPost, target, nil, []byte(`{"a":1}`))
		if err == nil {
			t.Fatalf("attempt %d reached a private address through a hostname", attempt)
		}
		var blocked *egress.BlockedTargetError
		if !errors.As(err, &blocked) {
			t.Fatalf("attempt %d: error is %T (%v), want *egress.BlockedTargetError", attempt, err, err)
		}
		if net.ParseIP(blocked.Target) == nil {
			t.Fatalf("attempt %d: the refusal named %q rather than a resolved address; the judgement was "+
				"not made on what was dialled", attempt, blocked.Target)
		}
		if !strings.Contains(blocked.Reason, "loopback") {
			t.Fatalf("attempt %d: reason = %q, want the reason to describe the ADDRESS that was refused",
				attempt, blocked.Reason)
		}
	}
	// 3. The second attempt is judged as freshly as the first: nothing cached a
	//    verdict for this hostname, so a name that changes its answer between
	//    two deliveries is re-judged on the address the second one dials.
	if n := listener.count(); n != 0 {
		t.Fatalf("%d connections reached the private listener across two attempts", n)
	}
}

// mustGuard builds an egress guard or fails the test.
func mustGuard(t *testing.T, allowPrivate bool, cidrs []string) *egress.Guard {
	t.Helper()
	guard, err := egress.NewGuard(allowPrivate, cidrs)
	if err != nil {
		t.Fatalf("build the egress guard: %v", err)
	}
	return guard
}
