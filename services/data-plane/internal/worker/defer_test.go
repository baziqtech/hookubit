package worker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/payloadstore"
)

// unreachableEndpoint is a server that fails the test if it is ever contacted.
// Every case in this file is about a delivery that must NOT reach the network.
func unreachableEndpoint(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a delivery that should have been turned away reached the endpoint")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ---------------------------------------------------------------------------
// the wall-clock budget on the defer path
// ---------------------------------------------------------------------------

// A delivery that is only ever DEFERRED must still be able to end.
//
// The defect: retry.Policy.Exhausted was reachable from exactly one place -
// Decide, on a COMPLETED attempt. A breaker refusal defers before any attempt
// is made, so the wall-clock budget was never evaluated for a delivery that
// never got one. An endpoint that is permanently dead therefore accumulated
// deliveries at ingest rate, each re-claimed every cooldown forever - and under
// the shipped FIFO claim (a strict global ordering with no tenant predicate)
// those ever-older rows sort AHEAD of live traffic, so one dead endpoint
// degrades the whole queue. There is no reaper in either plane to catch them.
func TestDeferredDeliveryExpiresWhenItsWallClockBudgetRunsOut(t *testing.T) {
	srv := unreachableEndpoint(t)

	cases := []struct {
		name    string
		arrange func(*harness, time.Time)
		opts    []func(*Options)
	}{
		{
			name: "behind a permanently open circuit breaker",
			arrange: func(h *harness, now time.Time) {
				h.health.set(h.job.Endpoint.ID, Health{
					State: HealthOpen, ConsecutiveFailures: 500, ProbeAfter: now.Add(10 * time.Minute),
				})
			},
		},
		{
			name: "behind a saturated endpoint rate limit",
			arrange: func(h *harness, _ time.Time) {
				h.store.job.Endpoint.RateLimit = 1
				h.store.job.Endpoint.RateLimitWindow = time.Hour
				// Drain the only token so the delivery under test is refused.
				h.worker.limiter.Allow(context.Background(),
					"endpoint:"+h.job.Endpoint.ID, 1, time.Hour)
			},
		},
		{
			name: "behind an object store that never comes back",
			arrange: func(h *harness, _ time.Time) {
				h.store.job.PayloadLocation = "s3://payloads/evt_01TEST"
			},
			opts: []func(*Options){func(o *Options) {
				f := newFakeFetcher()
				f.err = payloadstore.ErrUnavailable
				o.Payloads = f
			}},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now()
			opts := append([]func(*Options){
				func(o *Options) { o.Now = func() time.Time { return now } },
			}, tc.opts...)

			h := newHarness(t, srv.URL, opts...)
			// 24h of budget, first seen 25h ago. The clock ran out while the
			// delivery was being turned away, which is exactly the case no
			// attempt-driven check can ever see.
			h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
			h.store.job.Policy.MaxAttempts = 8
			h.store.job.FirstAttemptAt = now.Add(-25 * time.Hour)
			tc.arrange(h, now)

			h.worker.handle(context.Background(), h.lease())

			_, defers := h.store.counts()
			if defers != 0 {
				t.Fatalf("the delivery was deferred %d more times; a delivery whose 24 hours are up must "+
					"stop being re-claimed, not go round again", defers)
			}
			got := h.store.lastCompletion(t)
			if got.Next.State != StateExhausted {
				t.Fatalf("state = %s, want exhausted", got.Next.State)
			}
			if got.Next.Reason != ReasonBudgetExhausted {
				t.Fatalf("reason = %s, want %s: it was the CLOCK that ran out, not the attempt count, and "+
					"the two send an operator to different knobs", got.Next.Reason, ReasonBudgetExhausted)
			}
			if got.Attempt != nil {
				t.Fatalf("an attempt row was written for a delivery that was never attempted: %+v", got.Attempt)
			}
			if got.Next.AttemptCount != 0 {
				t.Fatalf("attempt_count was advanced to %d by a delivery that made no request; the attempt "+
					"budget is spent by requests, not by refusals", got.Next.AttemptCount)
			}
		})
	}
}

// The other half of the rule: a defer inside the budget is still just a defer,
// and it still spends no attempt.
func TestDeferInsideTheBudgetStillDefersAndSpendsNoAttempt(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	h := newHarness(t, srv.URL, func(o *Options) { o.Now = func() time.Time { return now } })
	h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
	h.store.job.FirstAttemptAt = now.Add(-23*time.Hour - 59*time.Minute)
	h.health.set(h.job.Endpoint.ID, Health{
		State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(time.Minute),
	})

	h.worker.handle(context.Background(), h.lease())

	if c, _ := h.store.counts(); c != 0 {
		t.Fatalf("a delivery with a minute of budget left was completed %d times, want a deferral", c)
	}
	got := h.store.lastDefer(t)
	if got.State != StateScheduled || got.Reason != ReasonBreakerOpen {
		t.Fatalf("transition = (%s, %s), want (scheduled, %s)", got.State, got.Reason, ReasonBreakerOpen)
	}
	if got.AttemptCount != 0 {
		t.Fatal("a deferral advanced attempt_count; no request was made, so no attempt may be charged")
	}
}

// A delivery with no duration cap, or with no origin to measure from, must never
// be expired on a guess.
func TestDeferNeverExpiresWithoutABudgetToMeasure(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	for _, tc := range []struct {
		name   string
		mutate func(*Job)
	}{
		{"no duration cap", func(j *Job) { j.Policy.MaxRetryDuration = 0 }},
		{"no first attempt time", func(j *Job) { j.FirstAttemptAt = time.Time{} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, srv.URL, func(o *Options) { o.Now = func() time.Time { return now } })
			h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
			h.store.job.FirstAttemptAt = now.Add(-1000 * time.Hour)
			tc.mutate(h.store.job)
			h.health.set(h.job.Endpoint.ID, Health{
				State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(time.Minute),
			})

			h.worker.handle(context.Background(), h.lease())

			if c, _ := h.store.counts(); c != 0 {
				t.Fatalf("a delivery with nothing to measure against was terminated (%d completions)", c)
			}
			h.store.lastDefer(t)
		})
	}
}

// ---------------------------------------------------------------------------
// the half-open probe
// ---------------------------------------------------------------------------

// A half-open probe slot must not be spent by a delivery that never reaches the
// network.
//
// The defect: breaker.Allow CLAIMS the probe slot (a conditional UPDATE), and
// the endpoint rate-limit check sat AFTER it. A recovering endpoint that also
// had endpoints.rate_limit set could have its one probe consumed by a delivery
// that then deferred, delaying recovery by a whole HalfOpenTTL each time -
// indefinitely if the bucket stayed saturated.
func TestRateLimitDoesNotSpendTheHalfOpenProbe(t *testing.T) {
	var hits int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	now := time.Now()
	h := newHarness(t, srv.URL, func(o *Options) { o.Now = func() time.Time { return now } })
	h.store.job.Endpoint.RateLimit = 1
	h.store.job.Endpoint.RateLimitWindow = time.Hour

	// One delivery goes out and takes the only token for the hour.
	h.worker.handle(context.Background(), h.lease())
	mu.Lock()
	if hits != 1 {
		mu.Unlock()
		t.Fatalf("setup: the endpoint saw %d requests, want 1", hits)
	}
	mu.Unlock()

	// Now the endpoint fails its way open and its cooldown elapses, so a probe
	// is due. The rate limit is still saturated.
	open := Health{State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(-time.Second)}
	h.health.set(h.job.Endpoint.ID, open)
	before := h.health.probeClaims()

	h.worker.handle(context.Background(), h.lease())

	if after := h.health.probeClaims(); after != before {
		t.Fatalf("the probe slot was claimed %d time(s) by a delivery the rate limiter then turned away; "+
			"that probe is the endpoint's only route back to healthy and it never reached the network",
			after-before)
	}
	if got := h.health.get(h.job.Endpoint.ID); got.State != HealthOpen || !got.ProbeAfter.Equal(open.ProbeAfter) {
		t.Fatalf("endpoint health = %+v, want it untouched (%+v): a refused delivery must leave the "+
			"breaker exactly as it found it", got, open)
	}
	got := h.store.lastDefer(t)
	if got.Reason != ReasonRateLimited {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonRateLimited)
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 1 {
		t.Fatalf("the endpoint saw %d requests with a limit of 1 per hour", hits)
	}
}

// The payload fetch is the other thing that used to sit on the wrong side, and
// its comment says so. This pins it: an object store that is down defers
// WITHOUT the probe having been claimed.
func TestPayloadOutageDoesNotSpendTheHalfOpenProbe(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	fetcher := newFakeFetcher()
	fetcher.err = payloadstore.ErrUnavailable

	h := newHarness(t, srv.URL,
		func(o *Options) { o.Now = func() time.Time { return now } },
		withFetcher(fetcher))
	h.store.job.PayloadLocation = "s3://payloads/evt_01TEST"
	h.health.set(h.job.Endpoint.ID, Health{
		State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(-time.Second),
	})

	h.worker.handle(context.Background(), h.lease())

	if n := h.health.probeClaims(); n != 0 {
		t.Fatalf("the probe slot was claimed %d time(s) before an outage of OURS deferred the delivery", n)
	}
	if got := h.store.lastDefer(t); got.Reason != ReasonPayloadUnavailable {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonPayloadUnavailable)
	}
}

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

// A drain-window expiry is OUR failure and must not be charged to the customer.
//
// The defect: cancelAttempts() cancelled with a plain context.Canceled, so the
// lease checks did not fire, retry.IsRetryableNetworkError defaulted to
// retryable, and an attempt row was written with the message "context canceled"
// while attempt_count advanced - and the endpoint's circuit breaker moved one
// failure closer to open. ReasonWorkerShutdown existed for exactly this and was
// referenced nowhere.
func TestShutdownCancelledAttemptIsNotChargedToTheEndpoint(t *testing.T) {
	var once sync.Once
	arrived := make(chan struct{})
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(arrived) })
		select {
		case <-release:
			w.WriteHeader(http.StatusOK)
		case <-r.Context().Done():
		}
	}))
	defer func() { close(release); srv.Close() }()

	h := newHarness(t, srv.URL)

	ctx, cancel := context.WithCancelCause(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.worker.handle(ctx, h.lease())
	}()

	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the endpoint never received the request")
	}
	// Exactly what worker.drain does when the drain window expires.
	cancel(ErrWorkerShutdown)

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the cancelled attempt never finished")
	}

	if c, _ := h.store.counts(); c != 0 {
		t.Fatalf("%d attempt rows were written for a request WE cancelled; the ledger now says the "+
			"customer's endpoint failed during our restart", c)
	}
	got := h.store.lastDefer(t)
	if got.Reason != ReasonWorkerShutdown {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonWorkerShutdown)
	}
	if got.State != StateScheduled {
		t.Fatalf("state = %s, want scheduled: the delivery goes back for another worker", got.State)
	}
	if got.AttemptCount != 0 {
		t.Fatalf("attempt_count advanced to %d because we shut down", got.AttemptCount)
	}
	if got.Delay <= 0 {
		t.Fatal("a shutdown deferral with no delay is re-claimed on the next poll")
	}
	if h.health.get(h.job.Endpoint.ID).ConsecutiveFailures != 0 {
		t.Fatal("our shutdown counted as a failure against the customer's circuit breaker")
	}
}

// The drain path is where the cause is attached. If it ever goes back to a bare
// cancel, everything above silently stops working.
func TestDrainCancelsWithTheShutdownCause(t *testing.T) {
	h := newHarness(t, "http://127.0.0.1:1")
	ctx, cancel := context.WithCancelCause(context.Background())
	var wg sync.WaitGroup

	h.worker.drain(&wg, cancel)

	if err := context.Cause(ctx); !errors.Is(err, ErrWorkerShutdown) {
		t.Fatalf("drain cancelled in-flight attempts with %v, want %v; without the cause a cancelled "+
			"attempt is indistinguishable from an endpoint that went silent", err, ErrWorkerShutdown)
	}
}

// A delivery whose budget is already spent when the drain lands still ends
// terminally rather than going back on the queue for ever.
func TestShutdownDeferStillHonoursAnExpiredBudget(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	h := newHarness(t, srv.URL, func(o *Options) { o.Now = func() time.Time { return now } })
	h.store.job.Policy.MaxRetryDuration = time.Hour
	h.store.job.FirstAttemptAt = now.Add(-2 * time.Hour)
	h.health.set(h.job.Endpoint.ID, Health{
		State: HealthOpen, ConsecutiveFailures: 5, ProbeAfter: now.Add(time.Minute),
	})

	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(ErrWorkerShutdown)
	h.worker.handle(ctx, h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateExhausted || got.Next.Reason != ReasonBudgetExhausted {
		t.Fatalf("transition = (%s, %s), want (exhausted, %s)",
			got.Next.State, got.Next.Reason, ReasonBudgetExhausted)
	}
}

// ---------------------------------------------------------------------------
// Retry-After, end to end through the delivery loop
// ---------------------------------------------------------------------------

func TestEndpointRetryAfterSchedulesTheNextAttempt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "900")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.store.job.Policy.JitterRatio = 0
	h.store.job.Policy.InitialDelay = 5 * time.Second
	h.store.job.Policy.MaxDelay = time.Hour

	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateRetrying {
		t.Fatalf("state = %s, want retrying", got.Next.State)
	}
	// The window is generous because Delay is measured against w.now() at write
	// time; what it must exclude is the policy's five seconds.
	if got.Next.Delay < 14*time.Minute || got.Next.Delay > 15*time.Minute {
		t.Fatalf("next attempt in %s, want about 15m: the endpoint asked to be left alone for 900s and we "+
			"scheduled on our own backoff anyway", got.Next.Delay)
	}
	if got.Attempt == nil || got.Attempt.ErrorCode != "http_429" {
		t.Fatalf("attempt row = %+v, want one coded http_429", got.Attempt)
	}
	if got.Attempt.ResponseHeaders["Retry-After"] != "900" {
		t.Fatalf("the attempt row did not preserve Retry-After: %v", got.Attempt.ResponseHeaders)
	}
}

// A hostile endpoint cannot park a delivery beyond any horizon an operator can
// see, and cannot push it past its own retry budget.
func TestAbsurdRetryAfterIsClampedOnTheDeliveryPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "999999999")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.store.job.Policy.JitterRatio = 0
	h.store.job.Policy.MaxDelay = 10 * time.Minute
	h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
	h.store.job.FirstAttemptAt = time.Now()

	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateRetrying {
		t.Fatalf("state = %s, want retrying", got.Next.State)
	}
	if got.Next.Delay > 10*time.Minute {
		t.Fatalf("next attempt in %s; an endpoint asking for ~31 years was allowed to set the schedule",
			got.Next.Delay)
	}
	if got.Next.Delay < 9*time.Minute {
		t.Fatalf("next attempt in %s, want the policy's max delay of 10m", got.Next.Delay)
	}
}

// ---------------------------------------------------------------------------
// the payload fetch has its own budget
// ---------------------------------------------------------------------------

// blockingFetcher blocks until its context is done or `hold` elapses. It is how
// "which deadline actually bounded the fetch" is observed.
type blockingFetcher struct {
	hold time.Duration
	body []byte
}

func (f *blockingFetcher) Get(ctx context.Context, _ string) ([]byte, error) {
	select {
	case <-time.After(f.hold):
		return f.body, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// PAYLOAD_DOWNLOAD_TIMEOUT_MS must not be silently truncated by
// INGEST_DB_TIMEOUT_MS. roles.go passed the DB timeout as the worker's only
// deadline, and the same context capped the object fetch, so an operator who
// raised the download timeout above it got the smaller of the two with nothing
// said about it.
func TestPayloadFetchUsesItsOwnBudgetNotTheDatabaseOne(t *testing.T) {
	body := []byte(`{"b":1,"a":2}`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL, func(o *Options) {
		o.DBTimeout = 60 * time.Millisecond
		o.PayloadTimeout = 5 * time.Second
		o.Payloads = &blockingFetcher{hold: 300 * time.Millisecond, body: body}
	})
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = "s3://payloads/evt_01TEST"
	h.store.job.PayloadHash = ""

	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateSucceeded {
		t.Fatalf("state = %s (%s), want succeeded: a 300ms fetch was cut off by the 60ms DATABASE timeout "+
			"despite a 5s payload budget", got.Next.State, got.Next.Reason)
	}
}

// And the budget is a real one: a fetch that overruns it defers rather than
// holding the worker slot.
func TestPayloadFetchIsBoundedByItsOwnBudget(t *testing.T) {
	srv := unreachableEndpoint(t)

	h := newHarness(t, srv.URL, func(o *Options) {
		o.DBTimeout = 5 * time.Second
		o.PayloadTimeout = 80 * time.Millisecond
		o.Payloads = &blockingFetcher{hold: 10 * time.Second}
	})
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = "s3://payloads/evt_01TEST"

	started := time.Now()
	h.worker.handle(context.Background(), h.lease())
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("the payload fetch held the worker for %s; PAYLOAD_DOWNLOAD_TIMEOUT_MS did not bound it",
			elapsed)
	}
	if got := h.store.lastDefer(t); got.Reason != ReasonPayloadUnavailable {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonPayloadUnavailable)
	}
}

// ---------------------------------------------------------------------------
// the wall-clock budget at the TENANT gate (G16)
// ---------------------------------------------------------------------------

// saturateProject fills the project ceiling so the next handle() is refused at
// the org/project gate - the one refusal that happens BEFORE the delivery row
// has been read, and therefore the one that had no budget to judge against.
func saturateProject(t *testing.T, h *harness) func() {
	t.Helper()
	rel, scope, ok := h.worker.gate.AcquireTenant(h.job.OrganizationID, h.job.ProjectID)
	if !ok {
		t.Fatalf("could not take the project's only slot; refused at %s", scope)
	}
	return rel
}

// The hole: `handle` refuses at the org/project gate before the delivery row is
// read, so it defers with unknownBudget, and a zero budget never expires by
// construction. A delivery that keeps losing there is rescheduled on every
// claim and never consults max_retry_duration - the exact failure the breaker
// path's wall-clock check closed, surviving on the one path that could not see
// the row.
//
// It compounds with G13: the condition that keeps a delivery losing at the
// project gate is a project saturated by slow endpoints, which is precisely
// what an unreserved per-endpoint ceiling produces.
func TestTenantGateEventuallyHonoursTheWallClockBudget(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	h := newHarness(t, srv.URL,
		func(o *Options) { o.Now = func() time.Time { return now } },
		func(o *Options) { o.Limits = GateLimits{Global: 8, Org: 8, Project: 1, Endpoint: 4} },
	)
	// 24h of budget, first seen 25h ago. The clock ran out while the delivery
	// was being turned away at a gate that never looked at it.
	h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
	h.store.job.Policy.MaxAttempts = 8
	h.store.job.FirstAttemptAt = now.Add(-25 * time.Hour)

	release := saturateProject(t, h)
	defer release()

	// The refusals before the threshold cost nothing extra: no row read, and
	// the delivery is deferred exactly as it always was.
	for i := 1; i < tenantGateBudgetCheckAfter; i++ {
		h.worker.handle(context.Background(), h.lease())
		if got := h.store.budgetReads(); got != 0 {
			t.Fatalf("refusal %d paid for %d budget reads; a momentary tenant ceiling must stay cheap", i, got)
		}
		if c, d := h.store.counts(); c != 0 || d != i {
			t.Fatalf("after refusal %d: %d completions, %d deferrals; want 0 and %d", i, c, d, i)
		}
	}

	// And then it stops being momentary, so the clock is finally consulted.
	h.worker.handle(context.Background(), h.lease())

	if got := h.store.budgetReads(); got != 1 {
		t.Fatalf("budget reads = %d, want exactly 1 on the %dth consecutive refusal",
			got, tenantGateBudgetCheckAfter)
	}
	if n := h.store.loadCount(); n != 0 {
		t.Fatalf("the tenant gate ran the FULL delivery load %d times; the whole point of the cheap read "+
			"is that a refusal never pays for the event join, the payload bytes and the secrets", n)
	}
	got := h.store.lastCompletion(t)
	if got.Next.State != StateExhausted || got.Next.Reason != ReasonBudgetExhausted {
		t.Fatalf("transition = (%s, %s), want (exhausted, %s): a delivery whose 24 hours are up must stop "+
			"being re-claimed, whichever gate was turning it away",
			got.Next.State, got.Next.Reason, ReasonBudgetExhausted)
	}
	if got.Attempt != nil {
		t.Fatalf("an attempt row was written for a delivery that was never attempted: %+v", got.Attempt)
	}
	if got.Next.AttemptCount != 0 {
		t.Fatalf("attempt_count was advanced to %d by a delivery that made no request", got.Next.AttemptCount)
	}
}

// The common case must be unchanged. A tenant ceiling really is momentary most
// of the time, and a delivery with budget left goes back to the ready set no
// matter how often it loses there.
func TestTenantGateStillDefersADeliveryThatHasTimeLeft(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	h := newHarness(t, srv.URL,
		func(o *Options) { o.Now = func() time.Time { return now } },
		func(o *Options) { o.Limits = GateLimits{Global: 8, Org: 8, Project: 1, Endpoint: 4} },
	)
	h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
	h.store.job.FirstAttemptAt = now.Add(-time.Minute)

	release := saturateProject(t, h)
	defer release()

	for i := 0; i < tenantGateBudgetCheckAfter*3; i++ {
		h.worker.handle(context.Background(), h.lease())
	}

	completions, defers := h.store.counts()
	if completions != 0 {
		t.Fatalf("a delivery with 23h59m of budget left was terminated %d times", completions)
	}
	if defers != tenantGateBudgetCheckAfter*3 {
		t.Fatalf("deferrals = %d, want %d: every refusal must still put the delivery back",
			defers, tenantGateBudgetCheckAfter*3)
	}
	// Cheap in the steady state: one read per threshold refusals, not one per
	// refusal.
	if got := h.store.budgetReads(); got != 3 {
		t.Fatalf("budget reads = %d over %d refusals, want 3 (one per %d)",
			got, tenantGateBudgetCheckAfter*3, tenantGateBudgetCheckAfter)
	}
}

// A delivery that gets THROUGH the gate is not stuck, and its streak restarts.
// Without this a delivery that is occasionally refused - the normal shape of a
// busy project - would accumulate refusals across hours and pay for reads it
// has not earned.
func TestTenantGateStreakResetsWhenTheDeliveryGetsThrough(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	h := newHarness(t, srv.URL,
		func(o *Options) { o.Now = func() time.Time { return now } },
		func(o *Options) { o.Limits = GateLimits{Global: 8, Org: 8, Project: 1, Endpoint: 4} },
	)
	h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
	h.store.job.FirstAttemptAt = now.Add(-25 * time.Hour)
	// The breaker is open, so a delivery that DOES get through the tenant gate
	// still never reaches the network - it is expired on the breaker path
	// instead, which is not what is being measured here.
	h.health.set(h.job.Endpoint.ID, Health{
		State: HealthOpen, ConsecutiveFailures: 500, ProbeAfter: now.Add(10 * time.Minute),
	})

	release := saturateProject(t, h)
	for i := 1; i < tenantGateBudgetCheckAfter; i++ {
		h.worker.handle(context.Background(), h.lease())
	}
	if got := h.store.budgetReads(); got != 0 {
		t.Fatalf("budget reads = %d before the threshold", got)
	}

	// One clean pass through the gate.
	release()
	h.worker.handle(context.Background(), h.lease())

	// Now saturate again: the streak restarted, so the next refusal is the
	// FIRST of a new one and pays nothing.
	release = saturateProject(t, h)
	defer release()
	h.worker.handle(context.Background(), h.lease())
	if got := h.store.budgetReads(); got != 0 {
		t.Fatalf("budget reads = %d; the streak survived a delivery that actually ran", got)
	}
}

// The budget read is an optimisation, not a decision maker. If it fails, the
// delivery must be deferred exactly as it was before this path existed - a
// database blip may never terminate a customer's delivery, and it may not stop
// the deferral either.
func TestTenantGateBudgetReadFailureStillDefers(t *testing.T) {
	srv := unreachableEndpoint(t)
	now := time.Now()

	h := newHarness(t, srv.URL,
		func(o *Options) { o.Now = func() time.Time { return now } },
		func(o *Options) { o.Limits = GateLimits{Global: 8, Org: 8, Project: 1, Endpoint: 4} },
	)
	h.store.job.Policy.MaxRetryDuration = 24 * time.Hour
	h.store.job.FirstAttemptAt = now.Add(-25 * time.Hour)
	h.store.budgetErr = errors.New("connection reset by peer")

	release := saturateProject(t, h)
	defer release()

	for i := 0; i < tenantGateBudgetCheckAfter; i++ {
		h.worker.handle(context.Background(), h.lease())
	}

	completions, defers := h.store.counts()
	if completions != 0 {
		t.Fatalf("a delivery was terminated on the strength of a FAILED budget read (%d completions)", completions)
	}
	if defers != tenantGateBudgetCheckAfter {
		t.Fatalf("deferrals = %d, want %d: a failed read must not swallow the deferral either",
			defers, tenantGateBudgetCheckAfter)
	}
}
