package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/shaq/hookubit/services/data-plane/internal/httpx"
)

func readyBody(t *testing.T, h http.Handler) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	var body struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode readiness body: %v", err)
	}
	return rec.Code, body.Status
}

// Readiness must not call a process that has never come up "draining".
//
// Both states answer 503 and both should, but they are opposite operator
// stories: "starting" clears on its own, "draining" means the pod is leaving.
// The distinction became observable when the probe server started binding
// before the database connection, so a pod waiting out a PostgreSQL outage now
// serves readiness for the whole wait.
func TestReadinessSeparatesStartupFromShutdown(t *testing.T) {
	t.Parallel()

	h := httpx.NewHealth(func(context.Context) map[string]string {
		return map[string]string{"postgres": "up"}
	})
	handler := h.Handler()

	code, status := readyBody(t, handler)
	if code != http.StatusServiceUnavailable || status != "starting" {
		t.Fatalf("before first readiness: got %d/%q, want 503/\"starting\"", code, status)
	}

	h.SetReady(true)
	if code, status := readyBody(t, handler); code != http.StatusOK || status != "ok" {
		t.Fatalf("once ready: got %d/%q, want 200/\"ok\"", code, status)
	}

	h.SetReady(false)
	if code, status := readyBody(t, handler); code != http.StatusServiceUnavailable || status != "draining" {
		t.Fatalf("after SIGTERM: got %d/%q, want 503/\"draining\"", code, status)
	}
}

// Liveness never touches PostgreSQL (ARCHITECTURE.md 46): if it did, a database
// blip would restart every pod at once and turn a recoverable incident into an
// outage. It must answer 200 even while readiness is refusing traffic.
func TestLivenessIgnoresDependencyState(t *testing.T) {
	t.Parallel()

	h := httpx.NewHealth(func(context.Context) map[string]string {
		return map[string]string{"postgres": "down"}
	})
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/live", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("liveness returned %d with the database down; that restarts the fleet", rec.Code)
	}
}
