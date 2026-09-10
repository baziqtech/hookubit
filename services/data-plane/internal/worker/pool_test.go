package worker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/queue"
)

// leaseFor builds a lease for a job the fake store will serve.
func leaseFor(job *Job, deliveryID string) queue.Lease {
	return queue.Lease{
		Job: queue.DeliveryJob{
			DeliveryID:     deliveryID,
			EventID:        job.EventID,
			EndpointID:     job.Endpoint.ID,
			OrganizationID: job.OrganizationID,
			ProjectID:      job.ProjectID,
		},
		WorkerID:  "wrk_test",
		ExpiresAt: time.Now().Add(time.Minute),
	}
}

// THE headline requirement (ARCHITECTURE.md 24): one customer's 30-second
// timeouts must not starve everyone else. The mechanism is a non-blocking
// per-endpoint ceiling with deferral - if this test starts failing because a
// gate was made to block instead, the whole reason this service is written in
// Go has been undone.
func TestOneSlowEndpointDoesNotConsumeThePool(t *testing.T) {
	var slowHits int64
	hang := make(chan struct{})
	releaseHang := sync.OnceFunc(func() { close(hang) })
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(&slowHits, 1)
		<-hang
		w.WriteHeader(http.StatusOK)
	}))
	defer func() { releaseHang(); slow.Close() }()

	var fastHits int64
	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(&fastHits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer fast.Close()

	slowJob, ring, _ := testJob(t, slow.URL)
	slowJob.Endpoint.MaxConcurrency = 1

	// A different endpoint with its OWN correctly-bound secret: the AAD binds a
	// ciphertext to one endpoint, so sharing the slow endpoint's secret here
	// would fail to decrypt and the test would prove nothing.
	fastJob, _, _ := testJobVector(t, fast.URL, 2)
	fastJob.Endpoint.MaxConcurrency = 8

	store := &fakeStore{jobs: map[string]*Job{}}
	store.jobs["del_fast"] = fastJob
	for i := 0; i < 6; i++ {
		store.jobs[slowDeliveryID(i)] = slowJob
	}

	w, err := New(Options{
		Queue:       newFakeQueue(),
		Store:       store,
		Health:      newFakeHealth(time.Now),
		Client:      testClient(t, testLimits()),
		Keyring:     ring,
		WorkerID:    "wrk_test",
		Concurrency: 8,
		Lease:       time.Minute,
		DBTimeout:   2 * time.Second,
		Logger:      discardLogger(),
		Seed:        11,
		Limits:      GateLimits{Global: 8, Org: 8, Project: 8, Endpoint: 1},
	})
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w.handle(context.Background(), leaseFor(slowJob, slowDeliveryID(i)))
		}(i)
	}

	// Five of the six must be turned away almost immediately rather than
	// queueing behind the hung request.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, defers := store.counts(); defers >= 5 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, defers := store.counts(); defers < 5 {
		t.Fatalf("only %d of 6 deliveries to a saturated endpoint were deferred; the rest are parked in the pool", defers)
	}
	if got := atomic.LoadInt64(&slowHits); got != 1 {
		t.Fatalf("the slow endpoint received %d concurrent requests with max_concurrency 1", got)
	}

	// And with the slow endpoint still hanging, another tenant is unaffected.
	done := make(chan struct{})
	go func() {
		w.handle(context.Background(), leaseFor(fastJob, "del_fast"))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a delivery to a healthy endpoint was blocked behind a hung one")
	}
	if atomic.LoadInt64(&fastHits) != 1 {
		t.Fatal("the healthy endpoint was never reached")
	}

	releaseHang()
	wg.Wait()
}

func slowDeliveryID(i int) string {
	return "del_slow_" + string(rune('a'+i))
}

// The pool must never claim work it has nowhere to run: leases held by a
// process that will not touch them for minutes are leases nobody else can take.
func TestPollClaimsOnlyAsManySlotsAsAreFree(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	job, ring, _ := testJob(t, srv.URL)
	store := &fakeStore{job: job}

	var mu sync.Mutex
	var requestedLimits []int
	q := &recordingQueue{fakeQueue: newFakeQueue(), onClaim: func(limit int) {
		mu.Lock()
		requestedLimits = append(requestedLimits, limit)
		mu.Unlock()
	}}
	for i := 0; i < 20; i++ {
		q.pending = append(q.pending, leaseFor(job, job.DeliveryID))
	}

	w, err := New(Options{
		Queue:        q,
		Store:        store,
		Health:       newFakeHealth(time.Now),
		Client:       testClient(t, testLimits()),
		Keyring:      ring,
		WorkerID:     "wrk_test",
		Concurrency:  3,
		ClaimBatch:   100,
		PollInterval: 5 * time.Millisecond,
		Lease:        time.Minute,
		DBTimeout:    time.Second,
		Logger:       discardLogger(),
		Seed:         3,
	})
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_ = w.Run(ctx)

	mu.Lock()
	defer mu.Unlock()
	if len(requestedLimits) == 0 {
		t.Fatal("the worker never polled")
	}
	for _, limit := range requestedLimits {
		if limit > 3 {
			t.Fatalf("claimed a batch of %d into a pool of 3; %d leases would be held by a worker that cannot run them",
				limit, limit-3)
		}
	}
	if w.InFlight() != 0 {
		t.Fatalf("%d attempts still in flight after Run returned", w.InFlight())
	}
}

// Shutdown is a drain, not a kill: an attempt that is mid-flight when SIGTERM
// lands must be finished and recorded, not abandoned to a lease expiry and
// re-delivered by the next pod.
func TestShutdownDrainsInFlightAttempts(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		once.Do(func() { close(started) })
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	job, ring, _ := testJob(t, srv.URL)
	store := &fakeStore{job: job}
	q := newFakeQueue(leaseFor(job, job.DeliveryID))

	w, err := New(Options{
		Queue:        q,
		Store:        store,
		Health:       newFakeHealth(time.Now),
		Client:       testClient(t, testLimits()),
		Keyring:      ring,
		WorkerID:     "wrk_test",
		Concurrency:  2,
		PollInterval: 5 * time.Millisecond,
		Lease:        time.Minute,
		DBTimeout:    2 * time.Second,
		Logger:       discardLogger(),
		Seed:         5,
	})
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		_ = w.Run(ctx)
		close(runDone)
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the delivery never started")
	}

	cancel() // SIGTERM lands mid-attempt
	time.Sleep(50 * time.Millisecond)
	select {
	case <-runDone:
		t.Fatal("Run returned while an attempt was still in flight; that is a kill, not a drain")
	default:
	}

	close(release)
	select {
	case <-runDone:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after the in-flight attempt finished")
	}

	got := store.lastCompletion(t)
	if got.Next.State != StateSucceeded {
		t.Fatalf("state = %s; an attempt that completed during the drain must be recorded", got.Next.State)
	}
}

type recordingQueue struct {
	*fakeQueue
	onClaim func(limit int)
}

func (r *recordingQueue) Claim(ctx context.Context, workerID string, limit int, lease time.Duration) ([]queue.Lease, error) {
	r.onClaim(limit)
	return r.fakeQueue.Claim(ctx, workerID, limit, lease)
}
