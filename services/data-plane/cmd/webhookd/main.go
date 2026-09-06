// Command webhookd is the data plane.
//
// One binary, several roles, selected by subcommand:
//
//	webhookd ingest      accept events over HTTP and persist them durably
//	webhookd router      drain the transactional outbox into delivery rows
//	webhookd scheduler   promote due deliveries and reclaim abandoned leases
//	webhookd worker      lease deliveries and perform outbound HTTP
//	webhookd all         run every role in one process (development)
//
// Packaging them together is deliberate (ARCHITECTURE.md 4): the roles are
// separate packages with no shared mutable state, so they can be split into
// separate deployments the day one of them needs to scale on its own, but until
// then a single image keeps development and deployment simple. Splitting is a
// change to the Kubernetes manifest, not to the code.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/config"
	"github.com/shaq/webhook-platform/services/data-plane/internal/db"
	"github.com/shaq/webhook-platform/services/data-plane/internal/httpx"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/logging"
)

// shutdownGrace bounds the whole shutdown, from signal to exit. The arithmetic
// that divides it between readiness propagation, the role drain and the probe
// server is documented on config.ShutdownGrace.
const shutdownGrace = config.ShutdownGrace

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: webhookd <ingest|router|scheduler|worker|all>")
	}
	role := os.Args[1]

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := logging.New(cfg.LogLevel, "webhookd-"+role)
	instanceID := ids.New(ids.Worker)

	// SIGTERM cancels this context, which every loop below selects on
	// (ARCHITECTURE.md 47).
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConnections, cfg.DatabaseStatementTimeout)
	if err != nil {
		return fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	defer pool.Close()

	health := httpx.NewHealth(func(ctx context.Context) map[string]string {
		state := "up"
		if err := pool.Ping(ctx); err != nil {
			state = "down"
		}
		return map[string]string{"postgres": state}
	})

	probes := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.MetricsPort),
		Handler:           health.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := probes.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("probe server stopped", "error", err)
		}
	}()

	log.Info("data plane starting",
		"role", role,
		"instance_id", instanceID,
		"app_env", cfg.AppEnv,
		"metrics_port", cfg.MetricsPort,
		"shutdown_readiness_delay", cfg.ShutdownReadinessDelay,
	)
	health.SetReady(true)

	runCtx, cancelRun, drainStartedAt := beginDrain(ctx, health, cfg.ShutdownReadinessDelay, log, role)
	defer cancelRun()

	runErr := dispatch(runCtx, role, cfg, pool, log, instanceID)

	// Idempotent: covers the path where a role exited on its own error and no
	// signal ever arrived.
	health.SetReady(false)

	// Phase 3 of the budget: whatever is left of shutdownGrace, measured from
	// the signal. Floor it so a role that overran still gets to close idle
	// probe connections rather than being handed an already-expired deadline.
	deadline := time.Now().Add(shutdownGrace)
	select {
	case signalledAt := <-drainStartedAt:
		if d := signalledAt.Add(shutdownGrace); d.After(time.Now().Add(time.Second)) {
			deadline = d
		} else {
			deadline = time.Now().Add(time.Second)
		}
	default:
	}
	probeCtx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	if err := probes.Shutdown(probeCtx); err != nil {
		log.Warn("probe server did not shut down cleanly", "error", err)
	}
	log.Info("data plane stopped", "role", role)

	if runErr != nil && !errors.Is(runErr, context.Canceled) {
		return runErr
	}
	return nil
}

// beginDrain orders the shutdown so readiness stops advertising BEFORE anything
// stops accepting.
//
// Roles run on the returned context, NOT on the signal context. Every serving
// role closes its listener the instant its context is cancelled (ingest.Serve
// does exactly that, and only then starts its 15s drain). If the roles ran on
// the signal context directly, SetReady(false) could not run until dispatch had
// unwound, so /health/ready would answer 200 for the whole drain window while
// the ingest port was already refusing connections. On a rolling update of the
// ingest Deployment that is a 502 on the write path for as long as the ingress
// backend list takes to converge - the one path that is never safe to drop.
//
// So: on signal, flip readiness immediately, keep accepting for
// readinessDelay so load balancers observe the not-ready state on an open
// socket, and only then cancel the role context. readinessDelay of 0 cancels
// straight away, so SIGTERM still terminates promptly.
//
// The returned channel carries the instant the signal landed (buffered, sent
// once, never closed), so the caller can measure the rest of its shutdown
// budget from the signal rather than from however long the role drain took.
// That is what stops the propagation delay extending the total budget; see
// config.ShutdownGrace for the arithmetic.
func beginDrain(
	signalCtx context.Context,
	health *httpx.Health,
	readinessDelay time.Duration,
	log *slogLogger,
	role string,
) (context.Context, context.CancelFunc, <-chan time.Time) {
	runCtx, cancelRun := context.WithCancel(context.Background())
	drainStartedAt := make(chan time.Time, 1)

	go func() {
		<-signalCtx.Done()
		drainStartedAt <- time.Now()

		// First, and before any listener closes.
		health.SetReady(false)
		log.Info("shutdown signal received; readiness now reports draining",
			"role", role,
			"readiness_delay", readinessDelay,
		)

		if readinessDelay > 0 {
			timer := time.NewTimer(readinessDelay)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-runCtx.Done():
				// A role failed on its own and the caller cancelled; do not
				// hold shutdown open for a propagation window nobody needs.
			}
		}
		cancelRun()
	}()

	return runCtx, cancelRun, drainStartedAt
}

func dispatch(
	ctx context.Context,
	role string,
	cfg *config.Config,
	pool *pgxpool.Pool,
	log *slogLogger,
	instanceID string,
) error {
	switch role {
	case "ingest":
		return runIngest(ctx, cfg, pool, log)
	case "router":
		return runRouter(ctx, cfg, pool, log)
	case "scheduler":
		return runScheduler(ctx, cfg, pool, log)
	case "worker":
		return runWorker(ctx, cfg, pool, log, instanceID)
	case "all":
		return runAll(ctx, cfg, pool, log, instanceID)
	default:
		return fmt.Errorf("unknown role %q: expected ingest, router, scheduler, worker or all", role)
	}
}
