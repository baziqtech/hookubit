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
	ready  atomic.Bool
	checks func(ctx context.Context) map[string]string
}

func NewHealth(checks func(ctx context.Context) map[string]string) *Health {
	return &Health{checks: checks}
}

// SetReady flips readiness. Set it false first on SIGTERM so the load balancer
// stops sending work before the process starts draining.
func (h *Health) SetReady(ready bool) { h.ready.Store(ready) }

func (h *Health) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})

	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if !h.ready.Load() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "draining"})
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
