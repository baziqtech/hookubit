// Package httpx holds shared HTTP plumbing for the data plane.
package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Health serves the liveness and readiness probes plus Prometheus metrics.
//
// Liveness deliberately does NOT touch PostgreSQL (ARCHITECTURE.md 46): if it
// did, a database blip would make Kubernetes restart every pod at once, turning
// a recoverable incident into an outage.
type Health struct {
	ready atomic.Bool
	// everReady separates "has not come up yet" from "is going away". Both
	// answer 503 and both must, but they are opposite operator stories: one
	// resolves itself, the other is the pod leaving. The distinction only
	// became observable once the probe server started binding BEFORE the
	// database connection (see cmd/webhookd, run()); until then a process that
	// could not reach PostgreSQL had already exited.
	everReady atomic.Bool
	checks    func(ctx context.Context) map[string]string
}

func NewHealth(checks func(ctx context.Context) map[string]string) *Health {
	return &Health{checks: checks}
}

// SetReady flips readiness. Set it false first on SIGTERM so the load balancer
// stops sending work before the process starts draining.
func (h *Health) SetReady(ready bool) {
	if ready {
		h.everReady.Store(true)
	}
	h.ready.Store(ready)
}

func (h *Health) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})

	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if !h.ready.Load() {
			status := "starting"
			if h.everReady.Load() {
				status = "draining"
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": status})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		results := map[string]string{}
		if h.checks != nil {
			results = h.checks(ctx)
		}
		for _, state := range results {
			if state != "up" {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "checks": results})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "checks": results})
	})

	mux.Handle("/metrics", promhttp.Handler())
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
