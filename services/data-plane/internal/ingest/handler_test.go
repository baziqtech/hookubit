package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
)

// fakeStore is an in-memory Store that reproduces the one constraint that
// matters: the unique (project_id, key) index on idempotency_keys.
type fakeStore struct {
	mu      sync.Mutex
	keys    map[string]*APIKeyRecord
	idem    map[string]*IdempotencyRecord
	events  []CreateEventParams
	touched int

	findKeyErr  error
	findIdemErr error
	createErr   error

	// beforeClaim runs inside CreateEvent before the idempotency claim, to
	// simulate a competing request committing first.
	beforeClaim func(*fakeStore)
	now         func() time.Time

	// createHadDeadline records whether the context reaching the store carried
	// one. Without it a stuck query pins a goroutine and a pool connection.
	createHadDeadline bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		keys: map[string]*APIKeyRecord{},
		idem: map[string]*IdempotencyRecord{},
		now:  time.Now,
	}
}

func (f *fakeStore) FindAPIKey(_ context.Context, keyHash string) (*APIKeyRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.findKeyErr != nil {
		return nil, f.findKeyErr
	}
	rec, ok := f.keys[keyHash]
	if !ok {
		return nil, ErrNotFound
	}
	clone := *rec
	return &clone, nil
}

func (f *fakeStore) FindIdempotency(_ context.Context, projectID, key string) (*IdempotencyRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.findIdemErr != nil {
		return nil, f.findIdemErr
	}
	rec, ok := f.idem[projectID+"\x00"+key]
	if !ok {
		return nil, ErrNotFound
	}
	clone := *rec
	return &clone, nil
}

func (f *fakeStore) CreateEvent(ctx context.Context, p CreateEventParams) (bool, error) {
	_, hasDeadline := ctx.Deadline()
	if f.beforeClaim != nil {
		hook := f.beforeClaim
		f.beforeClaim = nil
		hook(f)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createHadDeadline = hasDeadline
	if f.createErr != nil {
		return false, f.createErr
	}
	if p.IdempotencyKey != "" {
		slot := p.ProjectID + "\x00" + p.IdempotencyKey
		if existing, ok := f.idem[slot]; ok && existing.ExpiresAt.After(f.now()) {
			return false, nil
		}
		f.idem[slot] = &IdempotencyRecord{
			Key:         p.IdempotencyKey,
			RequestHash: p.RequestHash,
			EventID:     p.EventID,
			ExpiresAt:   p.IdempotencyExpiresAt,
		}
	}
	f.events = append(f.events, p)
	return true, nil
}

func (f *fakeStore) TouchAPIKey(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched++
	return nil
}

func (f *fakeStore) eventCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.events)
}

func (f *fakeStore) lastEvent(t *testing.T) CreateEventParams {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.events) == 0 {
		t.Fatal("no event was persisted")
	}
	return f.events[len(f.events)-1]
}

type fixture struct {
	handler   *Handler
	store     *fakeStore
	projectID string
	apiKey    string
	payloads  *fakePayloadStore
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	store := newFakeStore()
	projectID := ids.New(ids.Project)
	apiKey := validKey
	store.keys[HashKey(apiKey)] = &APIKeyRecord{
		ID:                 ids.New(ids.APIKey),
		ProjectID:          projectID,
		OrganizationID:     ids.New(ids.Organization),
		KeyEnvironment:     "live",
		ProjectEnvironment: "live",
		ProjectStatus:      "active",
	}
	payloads := &fakePayloadStore{}
	h := New(Options{
		Store:    store,
		Payloads: payloads,
		Limits:   PayloadLimits{InlineMax: 512, Max: 1024},
		Logger:   slog.New(slog.NewJSONHandler(io.Discard, nil)),
	})
	return &fixture{handler: h, store: store, projectID: projectID, apiKey: apiKey, payloads: payloads}
}

func (f *fixture) post(t *testing.T, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+f.projectID+"/events", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.apiKey)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

const goodBody = `{"event_type":"order.created","data":{"order_id":"ord_123"}}`

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) ErrorBody {
	t.Helper()
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rec.Body.String())
	}
	return body
}

func assertErrorShape(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) ErrorBody {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type = %q", ct)
	}
	body := decodeError(t, rec)
	if body.Error.Code != code {
		t.Fatalf("code = %q, want %q", body.Error.Code, code)
	}
	if body.Error.Message == "" {
		t.Fatal("message is empty")
	}
	if !strings.HasPrefix(body.Error.RequestID, "req_") {
		t.Fatalf("request_id = %q, want a req_ prefixed id", body.Error.RequestID)
	}
	if body.Error.RequestID != rec.Header().Get(headerRequestID) {
		t.Fatal("request_id in the body does not match the X-Request-Id header")
	}
	// The envelope has exactly one key, "error", with exactly three fields.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 1 {
		t.Fatalf("error envelope has %d top-level keys, want 1", len(raw))
	}
	var detail map[string]json.RawMessage
	if err := json.Unmarshal(raw["error"], &detail); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"code", "message", "request_id"} {
		if _, ok := detail[field]; !ok {
			t.Fatalf("error object is missing %q", field)
		}
	}
	// `details` is the only permitted extra: it is where a 429 carries
	// retry_after_seconds. Anything else appearing here is an accidental
	// widening of a public contract.
	for field := range detail {
		switch field {
		case "code", "message", "request_id", "details":
		default:
			t.Fatalf("error object carries unexpected field %q", field)
		}
	}
	return body
}

func TestAcceptedResponse(t *testing.T) {
	f := newFixture(t)
	rec := f.post(t, goodBody, nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.String())
	}
	var body AcceptedBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "accepted" {
		t.Fatalf("status = %q, want accepted", body.Status)
	}
	if !strings.HasPrefix(body.ID, "evt_") {
		t.Fatalf("id = %q, want an evt_ prefixed id", body.ID)
	}

	ev := f.store.lastEvent(t)
	if ev.EventID != body.ID {
		t.Fatal("the returned id is not the id that was persisted")
	}
	if string(ev.Payload) != goodBody {
		t.Fatalf("persisted payload = %q, want the exact request bytes", ev.Payload)
	}
	if ev.PayloadHash != HashPayload([]byte(goodBody)) {
		t.Fatal("payload_hash is not the SHA-256 of the exact request bytes")
	}
	if ev.PayloadSize != len(goodBody) {
		t.Fatalf("payload_size = %d, want %d", ev.PayloadSize, len(goodBody))
	}
	if ev.EventType != "order.created" {
		t.Fatalf("event_type = %q", ev.EventType)
	}
	if ev.IdempotencyExpiresAt.IsZero() {
		t.Fatal("idempotency expiry was not set")
	}
}

// Byte-exactness is the whole contract with signing: a payload that differs
// only in whitespace or key order must be stored, and hashed, verbatim.
func TestPersistedPayloadIsNeverReserialised(t *testing.T) {
	f := newFixture(t)
	body := "{ \"data\" : {\"z\":1,\"a\":2} ,\n  \"event_type\":\"order.created\" }"
	if rec := f.post(t, body, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	ev := f.store.lastEvent(t)
	if string(ev.Payload) != body {
		t.Fatalf("payload = %q, want %q", ev.Payload, body)
	}
	if ev.PayloadHash != HashPayload([]byte(body)) {
		t.Fatal("hash does not cover the exact bytes")
	}
}

func TestOrderingKeyIsStored(t *testing.T) {
	f := newFixture(t)
	body := `{"event_type":"order.created","data":{},"ordering_key":"customer_123"}`
	if rec := f.post(t, body, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	ev := f.store.lastEvent(t)
	var meta map[string]string
	if err := json.Unmarshal(ev.Headers, &meta); err != nil {
		t.Fatalf("headers is not a JSON object: %v", err)
	}
	if meta["ordering_key"] != "customer_123" {
		t.Fatalf("ordering_key = %q", meta["ordering_key"])
	}
}

func TestAuthenticationFailures(t *testing.T) {
	cases := []struct {
		name       string
		authHeader string
		mutate     func(*fixture)
	}{
		{"no header", "", nil},
		{"wrong scheme", "Basic " + validKey, nil},
		{"unknown key", "Bearer wk_live_ffffffffffffffffffffffffffffffff", nil},
		{"malformed key", "Bearer nonsense", nil},
		{"revoked key", "Bearer " + validKey, func(f *fixture) {
			past := time.Now().Add(-time.Hour)
			f.store.keys[HashKey(validKey)].RevokedAt = &past
		}},
		{"expired key", "Bearer " + validKey, func(f *fixture) {
			past := time.Now().Add(-time.Hour)
			f.store.keys[HashKey(validKey)].ExpiresAt = &past
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			if tc.mutate != nil {
				tc.mutate(f)
			}
			req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+f.projectID+"/events", strings.NewReader(goodBody))
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			f.handler.ServeHTTP(rec, req)

			assertErrorShape(t, rec, http.StatusUnauthorized, CodeUnauthenticated)
			if f.store.eventCount() != 0 {
				t.Fatal("an unauthenticated request created an event")
			}
		})
	}
}

// A key that is valid but not yet revoked at this instant must still work; the
// comparison is strictly "in the past".
func TestKeyRevokedInTheFutureStillWorks(t *testing.T) {
	f := newFixture(t)
	future := time.Now().Add(time.Hour)
	f.store.keys[HashKey(validKey)].RevokedAt = &future
	if rec := f.post(t, goodBody, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestKeyForAnotherProjectIsNotFound(t *testing.T) {
	f := newFixture(t)
	other := ids.New(ids.Project)
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+other+"/events", strings.NewReader(goodBody))
	req.Header.Set("Authorization", "Bearer "+f.apiKey)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)

	// not_found rather than forbidden: confirming that someone else's project
	// exists is itself a disclosure.
	assertErrorShape(t, rec, http.StatusNotFound, CodeNotFound)
}

func TestSuspendedProjectIsForbidden(t *testing.T) {
	f := newFixture(t)
	f.store.keys[HashKey(validKey)].ProjectStatus = "suspended"
	rec := f.post(t, goodBody, nil)
	assertErrorShape(t, rec, http.StatusForbidden, CodeForbidden)
}

func TestEnvironmentMismatchIsForbidden(t *testing.T) {
	f := newFixture(t)
	f.store.keys[HashKey(validKey)].KeyEnvironment = "test"
	rec := f.post(t, goodBody, nil)
	assertErrorShape(t, rec, http.StatusForbidden, CodeForbidden)
	if f.store.eventCount() != 0 {
		t.Fatal("a test key wrote an event into a live project")
	}
}

func TestUnknownPathAndMethod(t *testing.T) {
	f := newFixture(t)

	req := httptest.NewRequest(http.MethodPost, "/v1/projects/not-an-id/events", strings.NewReader(goodBody))
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	assertErrorShape(t, rec, http.StatusNotFound, CodeNotFound)

	req = httptest.NewRequest(http.MethodGet, "/v1/projects/"+f.projectID+"/events", nil)
	rec = httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	assertErrorShape(t, rec, http.StatusMethodNotAllowed, CodeInvalidRequest)
	if rec.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("Allow header = %q", rec.Header().Get("Allow"))
	}
}

func TestValidationFailureIsBadRequest(t *testing.T) {
	f := newFixture(t)
	rec := f.post(t, `{"data":{}}`, nil)
	body := assertErrorShape(t, rec, http.StatusBadRequest, CodeInvalidRequest)
	if !strings.Contains(body.Error.Message, "event_type") {
		t.Fatalf("message = %q, want it to name the field", body.Error.Message)
	}
}

func TestNonJSONContentTypeIsRejected(t *testing.T) {
	f := newFixture(t)
	rec := f.post(t, goodBody, map[string]string{"Content-Type": "text/plain"})
	assertErrorShape(t, rec, http.StatusBadRequest, CodeInvalidRequest)
}

func TestPayloadOverTheHardLimitIs413(t *testing.T) {
	f := newFixture(t)
	// 1024 is the configured maximum; overshoot it comfortably.
	body := `{"event_type":"order.created","data":{"blob":"` + strings.Repeat("x", 2000) + `"}}`
	rec := f.post(t, body, nil)
	assertErrorShape(t, rec, http.StatusRequestEntityTooLarge, CodePayloadTooLarge)
	if f.store.eventCount() != 0 {
		t.Fatal("an oversized payload was persisted")
	}
}

func TestPayloadAtTheInlineLimitIsOffloaded(t *testing.T) {
	f := newFixture(t)
	filler := strings.Repeat("x", 512-len(`{"event_type":"order.created","data":{"blob":""}}`))
	body := `{"event_type":"order.created","data":{"blob":"` + filler + `"}}`
	if len(body) != 512 {
		t.Fatalf("test body is %d bytes, expected exactly the inline limit", len(body))
	}
	if rec := f.post(t, body, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	ev := f.store.lastEvent(t)
	if ev.Payload != nil {
		t.Fatal("an offloaded payload was also stored inline")
	}
	if ev.PayloadLocation == "" {
		t.Fatal("payload_location was not set")
	}
	if ev.PayloadSize != 512 {
		t.Fatalf("payload_size = %d, want 512", ev.PayloadSize)
	}
	if ev.PayloadHash != HashPayload([]byte(body)) {
		t.Fatal("hash does not cover the exact bytes of an offloaded payload")
	}
}

func TestIdempotentReplayReturnsTheOriginalEvent(t *testing.T) {
	f := newFixture(t)
	headers := map[string]string{"Idempotency-Key": "order_123_created_v1"}

	first := f.post(t, goodBody, headers)
	if first.Code != http.StatusAccepted {
		t.Fatalf("first status = %d", first.Code)
	}
	var firstBody AcceptedBody
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}

	second := f.post(t, goodBody, headers)
	if second.Code != http.StatusAccepted {
		t.Fatalf("replay status = %d, want 202", second.Code)
	}
	var secondBody AcceptedBody
	if err := json.Unmarshal(second.Body.Bytes(), &secondBody); err != nil {
		t.Fatal(err)
	}
	if secondBody.ID != firstBody.ID {
		t.Fatalf("replay returned %s, want the original %s", secondBody.ID, firstBody.ID)
	}
	if f.store.eventCount() != 1 {
		t.Fatalf("%d events created, want 1", f.store.eventCount())
	}
}

func TestIdempotencyKeyReusedWithADifferentBodyIsAConflict(t *testing.T) {
	f := newFixture(t)
	headers := map[string]string{"Idempotency-Key": "order_123_created_v1"}

	if rec := f.post(t, goodBody, headers); rec.Code != http.StatusAccepted {
		t.Fatalf("first status = %d", rec.Code)
	}
	rec := f.post(t, `{"event_type":"order.created","data":{"order_id":"ord_999"}}`, headers)
	assertErrorShape(t, rec, http.StatusConflict, CodeIdempotencyKeyReused)
	if f.store.eventCount() != 1 {
		t.Fatalf("%d events created, want 1", f.store.eventCount())
	}
}

// Even a whitespace-only difference is a conflict: the hash is over the exact
// bytes, and being wrong in this direction is the safe one.
func TestIdempotencyIsByteExact(t *testing.T) {
	f := newFixture(t)
	headers := map[string]string{"Idempotency-Key": "k1"}
	if rec := f.post(t, goodBody, headers); rec.Code != http.StatusAccepted {
		t.Fatalf("first status = %d", rec.Code)
	}
	rec := f.post(t, goodBody+" ", headers)
	assertErrorShape(t, rec, http.StatusConflict, CodeIdempotencyKeyReused)
}

// The store reports the claim was lost to a concurrent request that committed
// first. The handler must answer from what actually committed, not create a
// second event.
func TestConcurrentInsertRaceResolvesToTheCommittedEvent(t *testing.T) {
	f := newFixture(t)
	winnerID := ids.New(ids.Event)
	f.store.beforeClaim = func(s *fakeStore) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.idem[f.projectID+"\x00"+"k1"] = &IdempotencyRecord{
			Key:         "k1",
			RequestHash: HashPayload([]byte(goodBody)),
			EventID:     winnerID,
			ExpiresAt:   time.Now().Add(time.Hour),
		}
	}
	rec := f.post(t, goodBody, map[string]string{"Idempotency-Key": "k1"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var body AcceptedBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ID != winnerID {
		t.Fatalf("id = %s, want the winner's event %s", body.ID, winnerID)
	}
	if f.store.eventCount() != 0 {
		t.Fatal("the loser of the race created a second event")
	}
}

// Same race, but the concurrent request carried a different body: the loser
// must be told, not aliased onto someone else's event.
func TestConcurrentInsertRaceWithADifferentBodyConflicts(t *testing.T) {
	f := newFixture(t)
	f.store.beforeClaim = func(s *fakeStore) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.idem[f.projectID+"\x00"+"k1"] = &IdempotencyRecord{
			Key:         "k1",
			RequestHash: "a-different-hash",
			EventID:     ids.New(ids.Event),
			ExpiresAt:   time.Now().Add(time.Hour),
		}
	}
	rec := f.post(t, goodBody, map[string]string{"Idempotency-Key": "k1"})
	assertErrorShape(t, rec, http.StatusConflict, CodeIdempotencyKeyReused)
}

func TestClaimedButUncommittedKeyIsAPlainConflict(t *testing.T) {
	f := newFixture(t)
	f.store.idem[f.projectID+"\x00"+"k1"] = &IdempotencyRecord{
		Key:         "k1",
		RequestHash: HashPayload([]byte(goodBody)),
		EventID:     "",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
	rec := f.post(t, goodBody, map[string]string{"Idempotency-Key": "k1"})
	assertErrorShape(t, rec, http.StatusConflict, CodeConflict)
}

func TestExpiredIdempotencyKeyIsReusable(t *testing.T) {
	f := newFixture(t)
	f.store.idem[f.projectID+"\x00"+"k1"] = &IdempotencyRecord{
		Key:         "k1",
		RequestHash: "stale",
		EventID:     ids.New(ids.Event),
		ExpiresAt:   time.Now().Add(-time.Minute),
	}
	rec := f.post(t, goodBody, map[string]string{"Idempotency-Key": "k1"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	if f.store.eventCount() != 1 {
		t.Fatalf("%d events created, want 1", f.store.eventCount())
	}
}

func TestRequestsWithoutAnIdempotencyKeyAlwaysCreate(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 3; i++ {
		if rec := f.post(t, goodBody, nil); rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d", rec.Code)
		}
	}
	if f.store.eventCount() != 3 {
		t.Fatalf("%d events created, want 3", f.store.eventCount())
	}
}

func TestOverlongIdempotencyKeyIsRejected(t *testing.T) {
	f := newFixture(t)
	rec := f.post(t, goodBody, map[string]string{"Idempotency-Key": strings.Repeat("k", 300)})
	assertErrorShape(t, rec, http.StatusBadRequest, CodeInvalidRequest)
}

type denyLimiter struct{}

func (denyLimiter) Allow(context.Context, Scope) (LimitDecision, error) {
	return LimitDecision{Allowed: false, RetryAfter: 7 * time.Second, LimitedScope: "project"}, nil
}

type faultyLimiter struct{}

func (faultyLimiter) Allow(context.Context, Scope) (LimitDecision, error) {
	return LimitDecision{}, errors.New("redis unreachable")
}

func TestRateLimitedRequestIs429AndCreatesNothing(t *testing.T) {
	f := newFixture(t)
	f.handler.limiter = denyLimiter{}
	rec := f.post(t, goodBody, nil)
	assertErrorShape(t, rec, http.StatusTooManyRequests, CodeRateLimited)
	if f.store.eventCount() != 0 {
		t.Fatal("a rate-limited request created an event")
	}
}

// A limiter that cannot reach its backing store must not reject traffic: Redis
// is a throughput control here, not the source of truth.
func TestRateLimiterFaultFailsOpen(t *testing.T) {
	f := newFixture(t)
	f.handler.limiter = faultyLimiter{}
	if rec := f.post(t, goodBody, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: a limiter outage must not become a customer outage", rec.Code)
	}
}

func TestStoreFailureIsInternalErrorAndLeaksNothing(t *testing.T) {
	f := newFixture(t)
	f.store.createErr = errors.New("connection refused to host db.internal:5432")
	rec := f.post(t, goodBody, nil)
	body := assertErrorShape(t, rec, http.StatusInternalServerError, CodeInternalError)
	if strings.Contains(body.Error.Message, "db.internal") {
		t.Fatalf("internal error message leaked infrastructure detail: %q", body.Error.Message)
	}
}

func TestEveryResponseCarriesAUniqueRequestID(t *testing.T) {
	f := newFixture(t)
	first := f.post(t, goodBody, nil).Header().Get(headerRequestID)
	second := f.post(t, goodBody, nil).Header().Get(headerRequestID)
	if first == "" || second == "" {
		t.Fatal("X-Request-Id was not set")
	}
	if first == second {
		t.Fatal("request ids are not unique")
	}
}

func TestTouchIsThrottledPerKey(t *testing.T) {
	tt := newTouchThrottle(time.Minute)
	base := time.Now()
	if !tt.should("key_a", base) {
		t.Fatal("first use must be recorded")
	}
	if tt.should("key_a", base.Add(time.Second)) {
		t.Fatal("a second use within the interval must be suppressed")
	}
	if !tt.should("key_b", base) {
		t.Fatal("a different key must be recorded")
	}
	if !tt.should("key_a", base.Add(2*time.Minute)) {
		t.Fatal("use after the interval must be recorded again")
	}
}

func TestTouchThrottleIsBounded(t *testing.T) {
	tt := newTouchThrottle(time.Hour)
	now := time.Now()
	for i := 0; i < maxTrackedKeys+10; i++ {
		tt.should(ids.New(ids.APIKey), now)
	}
	tt.mu.Lock()
	size := len(tt.seen)
	tt.mu.Unlock()
	if size > maxTrackedKeys {
		t.Fatalf("throttle map grew to %d entries", size)
	}
}

func TestParseEventsPath(t *testing.T) {
	valid := ids.New(ids.Project)
	if got, ok := parseEventsPath("/v1/projects/" + valid + "/events"); !ok || got != valid {
		t.Fatalf("parse = %q, %v", got, ok)
	}
	if _, ok := parseEventsPath("/v1/projects/" + valid + "/events/"); !ok {
		t.Fatal("a trailing slash must still match")
	}
	for _, path := range []string{
		"/", "/v1/projects", "/v1/projects/" + valid,
		"/v1/projects/" + valid + "/deliveries",
		"/v2/projects/" + valid + "/events",
		"/v1/projects/evt_01ARZ3NDEKTSV4RRFFQ69G5FAV/events",
		"/v1/projects/proj_not_a_ulid/events",
	} {
		if _, ok := parseEventsPath(path); ok {
			t.Fatalf("path %q must not match", path)
		}
	}
}

// nulEscapeBody is valid JSON: json.Decoder accepts the escape, jsonb cannot
// store it. Written as a concatenation so the escape stays visible in source.
const nulEscapeBody = `{"event_type":"order.created","data":{"note":"a` + `\u0000` + `b"}}`

// A NUL escape is a client error, not a platform fault. Before this was
// validated it reached the INSERT, PostgreSQL rejected it ("unsupported Unicode
// escape sequence"), the transaction rolled back so the idempotency claim never
// persisted, and the client's retry loop got the same 500 forever.
func TestNULEscapeIsRejectedAsInvalidRequest(t *testing.T) {
	f := newFixture(t)
	rec := f.post(t, nulEscapeBody, map[string]string{"Idempotency-Key": "nul_key_1"})
	assertErrorShape(t, rec, http.StatusBadRequest, CodeInvalidRequest)
	if f.store.eventCount() != 0 {
		t.Fatal("a payload with a NUL escape reached the store")
	}
}

// blockingStore never answers, the way a lock wait or a failed-over replica
// never answers. Only a deadline gets the goroutine and its pool connection
// back.
type blockingStore struct {
	*fakeStore
	entered chan struct{}
	once    sync.Once
}

func (b *blockingStore) FindAPIKey(ctx context.Context, _ string) (*APIKeyRecord, error) {
	b.once.Do(func() { close(b.entered) })
	<-ctx.Done()
	return nil, ctx.Err()
}

// http.Server.WriteTimeout does not cancel r.Context() - it only sets a write
// deadline - and r.Context() is cancelled solely on client disconnect. So the
// accept pipeline has to impose its own deadline, or a stuck query holds a
// goroutine and a pool connection until the pool is exhausted.
func TestIngestDatabaseCallsAreBounded(t *testing.T) {
	blocking := &blockingStore{fakeStore: newFakeStore(), entered: make(chan struct{})}
	h := New(Options{
		Store:     blocking,
		Limits:    PayloadLimits{InlineMax: 512, Max: 1024},
		Logger:    slog.New(slog.NewJSONHandler(io.Discard, nil)),
		DBTimeout: 50 * time.Millisecond,
	})

	projectID := ids.New(ids.Project)
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+projectID+"/events", strings.NewReader(goodBody))
	req.Header.Set("Authorization", "Bearer "+validKey)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	start := time.Now()
	go func() {
		defer close(done)
		h.ServeHTTP(rec, req)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler never returned: the accept pipeline has no deadline")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("handler took %s; the deadline was not what freed it", elapsed)
	}
	<-blocking.entered
	assertErrorShape(t, rec, http.StatusInternalServerError, CodeInternalError)
}

// The deadline must survive all the way to the write, not just the lookups.
func TestCreateEventReceivesADeadline(t *testing.T) {
	f := newFixture(t)
	if rec := f.post(t, goodBody, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	f.store.mu.Lock()
	defer f.store.mu.Unlock()
	if !f.store.createHadDeadline {
		t.Fatal("CreateEvent ran on a context with no deadline")
	}
}

// --- orphaned payload objects ---------------------------------------------
//
// PlanPayload uploads BEFORE the transaction. Every path below is one where the
// upload happened and the events row did not, and the difference between them
// is whether we can be SURE of that.

// A lost idempotency race is unambiguous: CreateEvent returned before its
// INSERT and rolled back, so nothing references the object we just wrote and it
// is deleted in the same request rather than left for the sweep.
func TestLostIdempotencyRaceDeletesTheObjectItJustUploaded(t *testing.T) {
	f := newFixture(t)
	// Above InlineMax (512) so the payload is offloaded.
	body := `{"event_type":"order.created","data":{"blob":"` + strings.Repeat("x", 600) + `"}}`
	winner := ids.New(ids.Event)

	// A competing request commits the same key while this one is in flight.
	f.store.beforeClaim = func(s *fakeStore) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.idem[f.projectID+"\x00"+"key-1"] = &IdempotencyRecord{
			Key:         "key-1",
			RequestHash: HashPayload([]byte(body)),
			EventID:     winner,
			ExpiresAt:   time.Now().Add(time.Hour),
		}
	}

	rec := f.post(t, body, map[string]string{"Idempotency-Key": "key-1"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.String())
	}
	if f.payloads.calls != 1 {
		t.Fatalf("uploads = %d, want 1", f.payloads.calls)
	}
	deleted := f.payloads.deletedLocations()
	if len(deleted) != 1 || deleted[0] != f.payloads.location {
		t.Fatalf("deleted = %v, want the orphan %q; a lost race must not leak an object",
			deleted, f.payloads.location)
	}
}

// A CreateEvent ERROR is ambiguous - a COMMIT that timed out may still have
// landed - so the object stays. Leaking storage is recoverable; deleting a live
// event's payload is not.
func TestAmbiguousPersistFailureLeavesTheObjectAlone(t *testing.T) {
	f := newFixture(t)
	f.store.createErr = errors.New("commit timed out")
	body := `{"event_type":"order.created","data":{"blob":"` + strings.Repeat("x", 600) + `"}}`

	rec := f.post(t, body, nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got := f.payloads.deletedLocations(); len(got) != 0 {
		t.Fatalf("deleted %v after an ambiguous failure; the commit may have landed", got)
	}
}

// The 202 contract: `accepted` means durably recoverable. A payload that
// reached neither PostgreSQL nor the bucket is neither, so the request fails.
func TestObjectStorageFailureIsNeverA202(t *testing.T) {
	f := newFixture(t)
	f.payloads.err = errors.New("bucket unreachable")
	body := `{"event_type":"order.created","data":{"blob":"` + strings.Repeat("x", 600) + `"}}`

	rec := f.post(t, body, nil)
	if rec.Code == http.StatusAccepted {
		t.Fatal("an event whose payload is not durable was accepted; 202 would be a lie")
	}
	assertErrorShape(t, rec, http.StatusInternalServerError, CodeInternalError)
	if f.store.eventCount() != 0 {
		t.Fatal("an events row was written for a payload that was never stored")
	}
}

// The offloaded row shape: payload_raw NULL, payload_location set, and
// payload_hash STILL the hash of the exact request bytes - which is what makes
// the delivery path able to check that what it fetched is what was sent.
func TestOffloadedEventRecordsLocationAndHashButNoInlinePayload(t *testing.T) {
	f := newFixture(t)
	body := `{"event_type":"order.created","data":{"blob":"` + strings.Repeat("x", 600) + `"}}`

	if rec := f.post(t, body, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body %s)", rec.Code, rec.Body.String())
	}
	got := f.store.lastEvent(t)
	if got.Payload != nil {
		t.Fatal("an offloaded payload was also written inline")
	}
	if got.PayloadLocation == "" {
		t.Fatal("payload_location is empty for an offloaded payload")
	}
	if got.PayloadSize != len(body) {
		t.Fatalf("payload_size = %d, want %d", got.PayloadSize, len(body))
	}
	if got.PayloadHash != HashPayload([]byte(body)) {
		t.Fatal("payload_hash is not the SHA-256 of the exact request bytes")
	}
	if string(f.payloads.stored) != body {
		t.Fatal("object storage did not receive the exact request bytes")
	}
}
