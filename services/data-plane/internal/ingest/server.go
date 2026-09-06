package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// Server timeouts. Every one of these exists because its absence is a way to be
// taken down by a slow or malicious client: a connection with no read deadline
// holds a goroutine and a file descriptor indefinitely.
const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 15 * time.Second
	writeTimeout      = 15 * time.Second
	idleTimeout       = 60 * time.Second
	// maxHeaderBytes is generous for a JSON API but far below the point where
	// headers become a memory-amplification vector.
	maxHeaderBytes = 64 << 10
)

// DrainTimeout bounds the drain. In-flight ingests are short; anything still
// running after this is stuck, and holding the process open does not help it.
//
// Exported because the shutdown arithmetic in cmd/webhookd budgets around it:
// the readiness-propagation delay plus this drain must fit inside the process
// shutdown grace.
const DrainTimeout = 15 * time.Second

// Serve runs the ingest HTTP server until ctx is cancelled, then drains.
//
// Shutdown is graceful on purpose: a request that has already COMMITted must
// get its 202, and a request that has not must not be half-applied. Since the
// event and its outbox row commit together, a killed in-flight request leaves
// nothing behind either way (ARCHITECTURE.md 57).
func Serve(ctx context.Context, port int, handler http.Handler, log *slog.Logger) error {
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("ingest api listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("ingest server: %w", err)
		}
		return nil
	case <-ctx.Done():
		drainCtx, cancel := context.WithTimeout(context.Background(), DrainTimeout)
		defer cancel()
		if err := srv.Shutdown(drainCtx); err != nil {
			log.Warn("ingest server did not drain cleanly", "error", err.Error())
		}
		<-errCh
		log.Info("ingest api stopped")
		return ctx.Err()
	}
}
