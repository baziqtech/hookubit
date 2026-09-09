package worker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/egress"
	"github.com/shaq/webhook-platform/services/data-plane/internal/queue"
	"github.com/shaq/webhook-platform/services/data-plane/internal/signing"
)

// testClient builds a real egress client that is allowed to dial the loopback
// address httptest uses. Everything else about it - the SSRF guard, the
// bounded read, the redirect policy - is the production code path.
func testClient(t *testing.T, limits egress.Limits) *egress.Client {
	t.Helper()
	guard, err := egress.NewGuard(true, nil)
	if err != nil {
		t.Fatalf("guard: %v", err)
	}
	return egress.NewClient(guard, limits)
}

func testLimits() egress.Limits {
	l := egress.DefaultLimits()
	l.TotalTimeout = 2 * time.Second
	l.ResponseHeaderTimeout = time.Second
	l.MaxResponseBytes = 1 << 10
	return l
}

type harness struct {
	worker *Worker
	store  *fakeStore
	health *fakeHealth
	queue  *fakeQueue
	job    *Job
	secret string
}

func newHarness(t *testing.T, url string, opts ...func(*Options)) *harness {
	t.Helper()
	job, ring, secret := testJob(t, url)
	store := &fakeStore{job: job}
	health := newFakeHealth(time.Now)
	q := newFakeQueue()

	o := Options{
		Queue:        q,
		Store:        store,
		Health:       health,
		Client:       testClient(t, testLimits()),
		Keyring:      ring,
		WorkerID:     "wrk_test",
		Concurrency:  4,
		PollInterval: 5 * time.Millisecond,
		Lease:        time.Minute,
		DBTimeout:    2 * time.Second,
		Logger:       discardLogger(),
		Seed:         42,
		Limits:       GateLimits{Global: 8, Org: 8, Project: 8, Endpoint: 4},
	}
	for _, fn := range opts {
		fn(&o)
	}
	w, err := New(o)
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}
	return &harness{worker: w, store: store, health: health, queue: q, job: job, secret: secret}
}

func (h *harness) lease() queue.Lease {
	return queue.Lease{
		Job: queue.DeliveryJob{
			DeliveryID:     h.job.DeliveryID,
			EventID:        h.job.EventID,
			EndpointID:     h.job.Endpoint.ID,
			OrganizationID: h.job.OrganizationID,
			ProjectID:      h.job.ProjectID,
		},
		WorkerID:  "wrk_test",
		ExpiresAt: time.Now().Add(time.Minute),
	}
}

func TestDeliverySuccess(t *testing.T) {
	var (
		mu      sync.Mutex
		gotHdrs http.Header
		gotBody []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		mu.Lock()
		gotHdrs = r.Header.Clone()
		gotBody = body
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateSucceeded {
		t.Fatalf("state = %s, want succeeded", got.Next.State)
	}
	if got.Next.Reason != ReasonDelivered {
		t.Fatalf("reason = %s", got.Next.Reason)
	}
	if got.Attempt == nil || got.Attempt.Number != 1 || got.Attempt.Status != AttemptSuccess {
		t.Fatalf("attempt row not recorded correctly: %+v", got.Attempt)
	}
	if got.Attempt.HTTPStatus != 200 {
		t.Fatalf("http_status = %d", got.Attempt.HTTPStatus)
	}
	if got.Next.AttemptCount != 1 {
		t.Fatalf("attempt_count = %d, want 1", got.Next.AttemptCount)
	}
	if got.Attempt.ResponseBody != `{"ok":true}` {
		t.Fatalf("response body not captured: %q", got.Attempt.ResponseBody)
	}

	mu.Lock()
	defer mu.Unlock()
	if string(gotBody) != string(h.job.Payload) {
		t.Fatalf("endpoint received %q, want the exact payload_raw bytes %q", gotBody, h.job.Payload)
	}
	if gotHdrs.Get("Webhook-Delivery-Id") != h.job.DeliveryID {
		t.Fatalf("Webhook-Delivery-Id = %q; it is how a consumer detects the duplicate an at-least-once system will eventually send",
			gotHdrs.Get("Webhook-Delivery-Id"))
	}
	// The signature must verify with the secret the TypeScript control plane
	// encrypted - the full loop, decrypt included.
	sigHeader := gotHdrs.Get("Webhook-Signature")
	if err := signing.Verify(sigHeader, h.secret, h.job.Payload, time.Minute, time.Now()); err != nil {
		t.Fatalf("consumer could not verify the signature with the control plane's secret: %v", err)
	}
	if h.health.get(h.job.Endpoint.ID).State != HealthHealthy {
		t.Fatalf("a success must leave the breaker healthy")
	}
}

func TestDeliveryOutcomesByStatus(t *testing.T) {
	cases := []struct {
		status     int
		wantState  State
		wantHealth bool // whether the endpoint should be counted as unhealthy
	}{
		{status: 200, wantState: StateSucceeded},
		{status: 202, wantState: StateSucceeded},
		{status: 400, wantState: StateFailed},
		{status: 404, wantState: StateFailed},
		{status: 408, wantState: StateRetrying, wantHealth: true},
		{status: 429, wantState: StateRetrying, wantHealth: true},
		{status: 500, wantState: StateRetrying, wantHealth: true},
		{status: 503, wantState: StateRetrying, wantHealth: true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(fmt.Sprintf("%d", tc.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()

			h := newHarness(t, srv.URL)
			h.worker.handle(context.Background(), h.lease())

			got := h.store.lastCompletion(t)
			if got.Next.State != tc.wantState {
				t.Fatalf("status %d -> %s, want %s", tc.status, got.Next.State, tc.wantState)
			}
			if got.Attempt.HTTPStatus != tc.status {
				t.Fatalf("attempt row recorded status %d", got.Attempt.HTTPStatus)
			}
			if tc.wantState == StateRetrying && got.Next.Delay <= 0 {
				t.Fatal("a retry was scheduled with no delay; that is a hot loop against a struggling endpoint")
			}

			failures := h.health.get(h.job.Endpoint.ID).ConsecutiveFailures
			if tc.wantHealth && failures != 1 {
				t.Fatalf("status %d must count against endpoint health, failures = %d", tc.status, failures)
			}
			if !tc.wantHealth && failures != 0 {
				t.Fatalf("status %d must NOT open the breaker: the endpoint is up and answering, failures = %d", tc.status, failures)
			}
		})
	}
}

func TestDeliveryTimeoutRetriesAndCountsAgainstHealth(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer func() { close(release); srv.Close() }()

	limits := testLimits()
	limits.TotalTimeout = 200 * time.Millisecond
	limits.ResponseHeaderTimeout = 150 * time.Millisecond

	h := newHarness(t, srv.URL, func(o *Options) { o.Client = testClient(t, limits) })
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateRetrying {
		t.Fatalf("state = %s, want retrying", got.Next.State)
	}
	if got.Attempt.Status != AttemptTimeout {
		t.Fatalf("attempt status = %s, want timeout", got.Attempt.Status)
	}
	if got.Attempt.ErrorCode != "timeout" {
		t.Fatalf("error code = %q, want timeout", got.Attempt.ErrorCode)
	}
	if got.Attempt.Duration <= 0 {
		t.Fatal("a timed-out attempt still took time; duration_ms must be recorded")
	}
	if h.health.get(h.job.Endpoint.ID).ConsecutiveFailures != 1 {
		t.Fatal("a timeout must count against endpoint health")
	}
}

// A server that answers headers and then hangs on the body must not hold a
// worker for ever.
func TestDeliveryBodyHangIsBounded(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-release
	}))
	defer func() { close(release); srv.Close() }()

	limits := testLimits()
	limits.TotalTimeout = 300 * time.Millisecond

	h := newHarness(t, srv.URL, func(o *Options) { o.Client = testClient(t, limits) })

	done := make(chan struct{})
	go func() {
		h.worker.handle(context.Background(), h.lease())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a hanging response body held the worker past the total timeout")
	}
	if c, _ := h.store.counts(); c != 1 {
		t.Fatalf("expected exactly one recorded outcome, got %d", c)
	}
}

func TestDeliveryOversizedResponseIsTruncatedNotFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(strings.Repeat("A", 512<<10)))
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL, func(o *Options) { o.MaxStoredResponseBytes = 256 })
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateSucceeded {
		t.Fatalf("state = %s; a large response body from a 200 is still a success", got.Next.State)
	}
	if len(got.Attempt.ResponseBody) > 512 {
		t.Fatalf("stored response body is %d bytes; the ledger must be bounded", len(got.Attempt.ResponseBody))
	}
	if !strings.Contains(got.Attempt.ResponseBody, "truncated") {
		t.Fatal("a truncated body must say so, or someone will debug a parse error against half a document")
	}
	if got.Attempt.ResponseSize > int(testLimits().MaxResponseBytes) {
		t.Fatalf("response_size = %d; the egress client should never have read more than its limit", got.Attempt.ResponseSize)
	}
}

func TestDeliveryRedirectToPrivateAddressIsRefusedPermanently(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "http://169.254.169.254/latest/meta-data/")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	limits := testLimits()
	limits.MaxRedirects = 3 // follow, so the guard - not the policy of zero - is what refuses

	h := newHarness(t, srv.URL, func(o *Options) { o.Client = testClient(t, limits) })
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateFailed {
		t.Fatalf("state = %s, want failed; a redirect to the metadata service will point there on every retry", got.Next.State)
	}
	if got.Next.Reason != ReasonBlockedTarget {
		t.Fatalf("reason = %s, want %s", got.Next.Reason, ReasonBlockedTarget)
	}
	if h.health.get(h.job.Endpoint.ID).ConsecutiveFailures != 0 {
		t.Fatal("our own SSRF policy must not open the customer's circuit breaker")
	}
}

func TestDeliveryFailsClosedWithNoSecrets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an unsigned delivery reached the endpoint")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.store.job.Secrets = nil
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Attempt == nil {
		t.Fatal("a delivery that could not be signed must still leave an attempt row; a gap in the ledger is not an answer")
	}
	if got.Attempt.ErrorCode != "signing_failed" {
		t.Fatalf("error code = %q, want signing_failed", got.Attempt.ErrorCode)
	}
	if got.Next.Reason != ReasonSigningFailed {
		t.Fatalf("reason = %s, want %s", got.Next.Reason, ReasonSigningFailed)
	}
}

func TestDeliveryFailsWithoutRawPayloadBytes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a delivery with no payload_raw was sent anyway")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// No payload_raw AND no payload_location: there is nowhere the bytes could
	// be. That is a recorded failure, not a deferral - deferring would leave
	// the delivery cycling forever over a row that will never gain bytes.
	h := newHarness(t, srv.URL)
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = ""
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.Reason != ReasonPayloadUnavailable {
		t.Fatalf("reason = %s, want %s", got.Next.Reason, ReasonPayloadUnavailable)
	}
	if got.Attempt.ErrorCode != "payload_unavailable" {
		t.Fatalf("error code = %q", got.Attempt.ErrorCode)
	}
}

func TestDisabledEndpointCancelsRatherThanRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a disabled endpoint received a delivery")
	}))
	defer srv.Close()

	for _, tc := range []struct {
		name    string
		mutate  func(*Job)
		wantWhy Reason
	}{
		{"enabled false", func(j *Job) { j.Endpoint.Enabled = false }, ReasonEndpointDisabled},
		{"status paused", func(j *Job) { j.Endpoint.Status = "paused" }, ReasonEndpointDisabled},
		{"status deleted", func(j *Job) { j.Endpoint.Status = "deleted" }, ReasonEndpointDeleted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, srv.URL)
			tc.mutate(h.store.job)
			h.worker.handle(context.Background(), h.lease())

			got := h.store.lastCompletion(t)
			if got.Next.State != StateCancelled {
				t.Fatalf("state = %s, want cancelled", got.Next.State)
			}
			if got.Next.Reason != tc.wantWhy {
				t.Fatalf("reason = %s, want %s", got.Next.Reason, tc.wantWhy)
			}
			if got.Attempt != nil {
				t.Fatal("no attempt was made, so no attempt row may be written")
			}
		})
	}
}

// The crash-safety rule: a worker whose lease was reclaimed mid-attempt must
// write NOTHING, even though it has a perfectly good HTTP response in hand.
func TestLeaseLostDuringAttemptWritesNothing(t *testing.T) {
	proceed := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-proceed
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	lease := h.lease()

	done := make(chan struct{})
	go func() {
		h.worker.handle(context.Background(), lease)
		close(done)
	}()

	// Wait until the attempt is tracked, then take the lease away exactly as a
	// failed renewal round would.
	deadline := time.Now().Add(2 * time.Second)
	for h.worker.keeper.Tracked() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	h.worker.keeper.Abandon(lease.Job.DeliveryID)
	close(proceed)
	<-done

	completions, defers := h.store.counts()
	if completions != 0 || defers != 0 {
		t.Fatalf("a worker that lost its lease wrote %d completions and %d defers; the row belongs to another worker and this is how a delivery gets two terminal statuses",
			completions, defers)
	}
}

func TestBreakerOpenDefersWithoutBurningAnAttempt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an open breaker let a delivery through")
	}))
	defer srv.Close()

	now := time.Now()
	h := newHarness(t, srv.URL, func(o *Options) { o.Now = func() time.Time { return now } })
	h.health.set(h.job.Endpoint.ID, Health{
		State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(time.Minute),
	})

	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastDefer(t)
	if got.State != StateScheduled {
		t.Fatalf("state = %s, want scheduled", got.State)
	}
	if got.Reason != ReasonBreakerOpen {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonBreakerOpen)
	}
	if got.AttemptCount != 0 {
		t.Fatal("a deferral must not advance attempt_count; no attempt was made")
	}
	if got.Delay <= 0 {
		t.Fatal("a deferral with no delay re-claims the row on the next poll")
	}
	if c, _ := h.store.counts(); c != 0 {
		t.Fatal("a deferral must not write an attempt row")
	}
}

func TestRateLimitDefersWithoutBurningAnAttempt(t *testing.T) {
	var hits int32
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.store.job.Endpoint.RateLimit = 1
	h.store.job.Endpoint.RateLimitWindow = time.Minute

	h.worker.handle(context.Background(), h.lease()) // consumes the only token
	h.worker.handle(context.Background(), h.lease()) // must be deferred

	got := h.store.lastDefer(t)
	if got.Reason != ReasonRateLimited {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonRateLimited)
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 1 {
		t.Fatalf("the endpoint was hit %d times with a limit of 1 per minute", hits)
	}
}

func TestDeliveryGoneIsNotRecorded(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.store.loadErr = ErrDeliveryGone
	h.worker.handle(context.Background(), h.lease())

	if c, d := h.store.counts(); c != 0 || d != 0 {
		t.Fatalf("a vanished delivery must not be written to: %d completions, %d defers", c, d)
	}
}

func TestTransientLoadFailureDefersRatherThanSpins(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	h.store.loadErr = fmt.Errorf("connection refused")
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastDefer(t)
	if got.Delay <= 0 {
		t.Fatal("a delivery deferred after a database fault must carry a delay, or the next poll re-claims it immediately")
	}
}
