package ingest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

var requestIDPattern = regexp.MustCompile(`"request_id":"[^"]*"`)

// postFrom is `fixture.post` with control over the source address, which is
// the whole variable under test here.
func postFrom(t *testing.T, f *fixture, remote string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+f.projectID+"/events", strings.NewReader(goodBody))
	req.Header.Set("Authorization", "Bearer "+f.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

func (f *fixture) setAllowlist(list []string) {
	f.store.mu.Lock()
	defer f.store.mu.Unlock()
	for _, rec := range f.store.keys {
		rec.ProjectAllowedIPs = list
	}
}

func TestIngestEmptyAllowlistAcceptsAnyAddress(t *testing.T) {
	f := newFixture(t)
	if rec := postFrom(t, f, "203.0.113.9:44321"); rec.Code != http.StatusAccepted {
		t.Fatalf("want 202 with no allowlist, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestIngestAllowlistAcceptsAPermittedAddress(t *testing.T) {
	f := newFixture(t)
	f.setAllowlist([]string{"203.0.113.0/24"})

	if rec := postFrom(t, f, "203.0.113.9:44321"); rec.Code != http.StatusAccepted {
		t.Fatalf("want 202 for a permitted address, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestIngestAllowlistRefusesAndNeverReadsTheBody(t *testing.T) {
	f := newFixture(t)
	f.setAllowlist([]string{"203.0.113.0/24"})

	rec := postFrom(t, f, "198.51.100.1:44321")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403 for a blocked address, got %d: %s", rec.Code, rec.Body.String())
	}

	// Nothing was stored. A refusal on this path must not create an event, a
	// claim, or an outbox row — the point of checking before the work.
	f.store.mu.Lock()
	events := len(f.store.events)
	f.store.mu.Unlock()
	if events != 0 {
		t.Fatalf("a refused address stored %d events", events)
	}

	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "forbidden" {
		t.Fatalf("want forbidden, got %q", body.Error.Code)
	}
	// The caller already knows their own address, and an operator whose
	// deployment moved subnets should not have to guess which one we saw.
	if !strings.Contains(body.Error.Message, "198.51.100.1") {
		t.Fatalf("the refusal should name the address, got %q", body.Error.Message)
	}
}

// THE POINT OF THE WHOLE FEATURE'S ORDERING.
//
// From a blocked address, a revoked key, an expired key, a key for another
// project and a perfectly good key must all produce the SAME answer. Anything
// else is an oracle for whether a credential an attacker holds is still live —
// and an attacker probing from an address you have already refused is exactly
// who that oracle is for.
func TestIngestAllowlistRefusalSaysNothingAboutTheKey(t *testing.T) {
	past := time.Now().Add(-time.Hour)

	cases := map[string]func(*APIKeyRecord){
		"good key":        func(*APIKeyRecord) {},
		"revoked key":     func(rec *APIKeyRecord) { rec.RevokedAt = &past },
		"expired key":     func(rec *APIKeyRecord) { rec.ExpiresAt = &past },
		"wrong project":   func(rec *APIKeyRecord) { rec.ProjectID = "proj_somebody_else" },
		"inactive projct": func(rec *APIKeyRecord) { rec.ProjectStatus = "suspended" },
		"wrong env":       func(rec *APIKeyRecord) { rec.KeyEnvironment = "test" },
	}

	var first string
	for name, mutate := range cases {
		f := newFixture(t)
		f.store.mu.Lock()
		for _, rec := range f.store.keys {
			rec.ProjectAllowedIPs = []string{"203.0.113.0/24"}
			mutate(rec)
		}
		f.store.mu.Unlock()

		rec := postFrom(t, f, "198.51.100.1:44321")
		// `request_id` is per request and is the one thing that MUST differ.
		answer := strconv.Itoa(rec.Code) + " " + requestIDPattern.ReplaceAllString(rec.Body.String(), `"request_id":"…"`)
		if first == "" {
			first = answer
			continue
		}
		if answer != first {
			t.Fatalf("%s answered differently from the first case:\n  %s\n  %s", name, first, answer)
		}
	}
}
