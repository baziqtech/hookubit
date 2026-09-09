package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
)

// requestIDPrefix matches the `req_...` shape quoted in error bodies and on
// every log line for the request (docs/API.md).
const requestIDPrefix = "req"

// headerRequestID is set on every response, success or failure, so an operator
// can correlate a customer's screenshot with the logs.
const headerRequestID = "X-Request-Id"

// DefaultDBTimeout bounds every database call the accept pipeline makes.
//
// It has to exist here: http.Server.WriteTimeout only sets a write deadline, it
// does not cancel r.Context(), and r.Context() is cancelled only when the
// client disconnects. pgxpool has no default statement timeout either, so
// without this a lock wait or a failed-over replica pins one goroutine and one
// pool connection per request until the pool is exhausted - after which new
// requests block in Acquire with no deadline of their own and shutdown cannot
// drain. DATABASE_STATEMENT_TIMEOUT_MS in internal/db is the server-side
// backstop for the same failure.
const DefaultDBTimeout = 5 * time.Second

// Options configures a Handler. Every field except Store has a working default.
type Options struct {
	Store   Store
	Limiter RateLimiter
	// Source is the pre-auth per-address ceiling. Nil disables it, which is
	// only appropriate when something in front of the process already bounds
	// an unauthenticated flood.
	Source *SourceLimiter
	// TrustedProxyHops is the EXACT number of proxies in front of this
	// process. See ClientAddress: it is never inferred and never "trust
	// everything".
	TrustedProxyHops int
	Payloads         PayloadStore
	Limits           PayloadLimits
	Logger           *slog.Logger
	IdempotencyTTL   time.Duration
	// DBTimeout bounds the database work of one accept. Defaults to
	// DefaultDBTimeout.
	DBTimeout time.Duration
	// Now is injectable so idempotency expiry is deterministic under test.
	Now func() time.Time
}

// Handler serves POST /v1/projects/{project_id}/events.
type Handler struct {
	store            Store
	limiter          RateLimiter
	source           *SourceLimiter
	trustedProxyHops int
	payloads         PayloadStore
	limits           PayloadLimits
	log              *slog.Logger
	idempotencyTTL   time.Duration
	dbTimeout        time.Duration
	now              func() time.Time
	touch            *touchThrottle
}

func New(opts Options) *Handler {
	h := &Handler{
		store:            opts.Store,
		limiter:          opts.Limiter,
		source:           opts.Source,
		trustedProxyHops: opts.TrustedProxyHops,
		payloads:         opts.Payloads,
		limits:           opts.Limits,
		log:              opts.Logger,
		idempotencyTTL:   opts.IdempotencyTTL,
		dbTimeout:        opts.DBTimeout,
		now:              opts.Now,
		touch:            newTouchThrottle(time.Minute),
	}
	if h.limiter == nil {
		h.limiter = AllowAll{}
	}
	if h.payloads == nil {
		h.payloads = NewUnconfiguredPayloadStore()
	}
	if h.log == nil {
		h.log = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	if h.idempotencyTTL <= 0 {
		h.idempotencyTTL = DefaultIdempotencyTTL
	}
	if h.dbTimeout <= 0 {
		h.dbTimeout = DefaultDBTimeout
	}
	if h.now == nil {
		h.now = time.Now
	}
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := ids.New(requestIDPrefix)
	w.Header().Set(headerRequestID, requestID)

	projectID, ok := parseEventsPath(r.URL.Path)
	if !ok {
		writeError(w, requestID, errNotFound("Unknown path"), h.log)
		metrics.EventsIngestionFailed.WithLabelValues(CodeNotFound).Inc()
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, requestID, &apiError{
			Status:  http.StatusMethodNotAllowed,
			Code:    CodeInvalidRequest,
			Message: "Only POST is supported on this path",
		}, h.log)
		metrics.EventsIngestionFailed.WithLabelValues(CodeInvalidRequest).Inc()
		return
	}

	started := h.now()
	log := h.log.With("request_id", requestID, "project_id", projectID)

	eventID, apiErr := h.accept(r, projectID, log)
	if apiErr != nil {
		metrics.EventsIngestionFailed.WithLabelValues(apiErr.Code).Inc()
		// Message text is contract, not customer data: safe to log.
		log.Warn("ingest rejected",
			"code", apiErr.Code,
			"status", apiErr.Status,
			"duration_ms", h.now().Sub(started).Milliseconds(),
		)
		writeError(w, requestID, apiErr, h.log)
		return
	}

	log.Info("event accepted",
		"event_id", eventID,
		"duration_ms", h.now().Sub(started).Milliseconds(),
	)
	writeJSON(w, http.StatusAccepted, AcceptedBody{ID: eventID, Status: "accepted"}, h.log)
}

// accept runs the acceptance pipeline in the order fixed by ARCHITECTURE.md 16.
// It returns the event ID that the caller should be told about - which for a
// replayed idempotency key is the ORIGINAL event, not a new one.
func (h *Handler) accept(r *http.Request, projectID string, log *slog.Logger) (string, *apiError) {
	// Every database call below inherits this deadline; see DefaultDBTimeout
	// for why the request context alone is not one. Reading the body is not
	// affected - that is bounded by http.Server.ReadTimeout.
	ctx, cancel := context.WithTimeout(r.Context(), h.dbTimeout)
	defer cancel()

	// 0. Pre-auth ceiling, BEFORE the database is touched.
	//
	// Steps 1..6 below are the order fixed by ARCHITECTURE.md 16 and this is
	// not an extra step in it - it is the gate in front of it. Step 1 costs a
	// connection from a pool of DATABASE_MAX_CONNECTIONS held for up to
	// DBTimeout, and it runs for anyone who can open a socket. Charging an
	// unauthenticated flood before that is the difference between a rate limit
	// and a denial-of-service window (see SourceLimiter).
	addr := ClientAddress(r, h.trustedProxyHops)
	if allowed, wait := h.source.Allow(addr); !allowed {
		metrics.RateLimitHits.WithLabelValues("source_ip").Inc()
		return "", errRateLimited(wait)
	}

	// 1. Authenticate the API key.
	key, apiErr := h.authenticate(ctx, r)
	if apiErr != nil {
		// A failed credential costs this address extra. It keeps the ceiling
		// generous for honest traffic and punitive for a key-spraying flood,
		// which is the only traffic that reaches this line repeatedly.
		if apiErr.Code == CodeUnauthenticated {
			h.source.Penalise(addr)
		}
		return "", apiErr
	}

	// 2. Resolve the project. The key already carries its project; the path
	// must agree. A key for another project is `not_found`, not `forbidden`:
	// telling a caller that a project exists but is not theirs is itself a
	// disclosure (ARCHITECTURE.md 8).
	if key.ProjectID != projectID {
		return "", errNotFound("Project not found")
	}
	if key.ProjectStatus != "active" {
		return "", errForbidden("Project is not active")
	}
	if key.KeyEnvironment != key.ProjectEnvironment {
		return "", errForbidden("API key environment does not match the project environment")
	}
	h.touchKey(key.ID)

	// 3. Validate the request.
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return "", errInvalidRequest("Content-Type must be application/json")
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if apiErr := ValidateIdempotencyKey(idempotencyKey); apiErr != nil {
		return "", apiErr
	}

	body, apiErr := h.readBody(r)
	if apiErr != nil {
		return "", apiErr
	}
	envelope, apiErr := ParseEnvelope(body)
	if apiErr != nil {
		return "", apiErr
	}

	// 4. Rate limit. A limiter fault must not reject traffic: Redis is a
	// throughput control here, not the source of truth.
	decision, err := h.limiter.Allow(ctx, Scope{
		OrganizationID: key.OrganizationID,
		ProjectID:      key.ProjectID,
		APIKeyID:       key.ID,
	})
	if err != nil {
		log.Error("rate limiter unavailable, failing open", "error", err.Error())
	} else if !decision.Allowed {
		log.Warn("rate limited", "limited_scope", decision.LimitedScope)
		return "", errRateLimited(decision.RetryAfter)
	}

	// The request hash is over the EXACT bytes received, which is also what
	// payload_hash records - so "same key, same body" is a byte comparison, not
	// a semantic one. Two requests that differ only in whitespace are a
	// conflict, and that is the safe direction to be wrong in.
	requestHash := HashPayload(body)

	// 5. Check idempotency before doing any work.
	if idempotencyKey != "" {
		eventID, decided, apiErr := h.checkIdempotency(ctx, projectID, idempotencyKey, requestHash)
		if apiErr != nil {
			return "", apiErr
		}
		if decided {
			return eventID, nil
		}
	}

	// 6. Persist: BEGIN, event, outbox, COMMIT.
	return h.persist(ctx, key, envelope, body, idempotencyKey, requestHash, log)
}

func (h *Handler) authenticate(ctx context.Context, r *http.Request) (*APIKeyRecord, *apiError) {
	credential, err := ParseBearer(r.Header.Get("Authorization"))
	if err != nil {
		return nil, errUnauthenticated("A bearer API key is required")
	}
	// Every failure below returns the same message. Distinguishing "not a key"
	// from "unknown key" from "revoked key" hands an attacker an oracle.
	const rejected = "Invalid API key"
	if err := ValidateKeyShape(credential); err != nil {
		return nil, errUnauthenticated(rejected)
	}
	record, err := h.store.FindAPIKey(ctx, HashKey(credential))
	if errors.Is(err, ErrNotFound) {
		return nil, errUnauthenticated(rejected)
	}
	if err != nil {
		h.log.Error("api key lookup failed", "error", err.Error())
		return nil, errInternal()
	}
	now := h.now()
	if record.RevokedAt != nil && !record.RevokedAt.After(now) {
		return nil, errUnauthenticated(rejected)
	}
	if record.ExpiresAt != nil && !record.ExpiresAt.After(now) {
		return nil, errUnauthenticated(rejected)
	}
	return record, nil
}

// readBody enforces the hard payload ceiling while reading, so an oversized
// request is refused without ever buffering all of it.
func (h *Handler) readBody(r *http.Request) ([]byte, *apiError) {
	limited := http.MaxBytesReader(nil, r.Body, h.limits.Max+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, errPayloadTooLarge("Payload exceeds the maximum event size")
		}
		return nil, errInvalidRequest("Could not read request body")
	}
	if apiErr := h.limits.CheckSize(int64(len(body))); apiErr != nil {
		return nil, apiErr
	}
	return body, nil
}

// checkIdempotency reports (eventID, decided, error). `decided` true means the
// response is settled without creating anything.
func (h *Handler) checkIdempotency(
	ctx context.Context, projectID, key, requestHash string,
) (string, bool, *apiError) {
	record, err := h.store.FindIdempotency(ctx, projectID, key)
	if errors.Is(err, ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		h.log.Error("idempotency lookup failed", "error", err.Error())
		return "", false, errInternal()
	}
	switch Decide(record, requestHash, h.now()) {
	case DecideReplay:
		return record.EventID, true, nil
	case DecideConflict:
		return "", true, errIdempotencyKeyReused()
	case DecideInFlight:
		return "", true, errConflict("A request with this idempotency key is still in progress")
	default:
		return "", false, nil
	}
}

func (h *Handler) persist(
	ctx context.Context,
	key *APIKeyRecord,
	envelope *Envelope,
	body []byte,
	idempotencyKey, requestHash string,
	log *slog.Logger,
) (string, *apiError) {
	eventID := ids.New(ids.Event)

	// NOTE: an offloaded payload is uploaded here, BEFORE the transaction. If
	// the claim below is lost or the insert fails, that object is orphaned - no
	// events row will ever reference it and nothing reclaims it. Uploading
	// after the claim would mean holding the ingest transaction open across an
	// S3 round trip, which is worse. See "Object storage reconciliation" in
	// HANDOFF.md: the fix is a lifecycle rule or a sweep on the bucket.
	plan, apiErr := PlanPayload(ctx, h.payloads, h.limits, key.ProjectID, eventID, body)
	if apiErr != nil {
		return "", apiErr
	}

	headers, err := requestMetadata(envelope)
	if err != nil {
		log.Error("encode event metadata", "error", err.Error())
		return "", errInternal()
	}

	created, err := h.store.CreateEvent(ctx, CreateEventParams{
		EventID:              eventID,
		OrganizationID:       key.OrganizationID,
		ProjectID:            key.ProjectID,
		EventType:            envelope.EventType,
		IdempotencyKey:       idempotencyKey,
		Payload:              plan.Inline,
		PayloadLocation:      plan.Location,
		PayloadSize:          plan.Size,
		PayloadHash:          plan.Hash,
		Headers:              headers,
		RequestHash:          requestHash,
		IdempotencyExpiresAt: h.now().Add(h.idempotencyTTL),
	})
	if err != nil {
		log.Error("persist event failed", "error", err.Error())
		return "", errInternal()
	}
	if !created {
		// Lost the race on the unique (project_id, key) index: another request
		// with the same key committed while this one was in flight. Re-read and
		// answer from what actually committed.
		eventID, decided, apiErr := h.checkIdempotency(ctx, key.ProjectID, idempotencyKey, requestHash)
		if apiErr != nil {
			return "", apiErr
		}
		if !decided {
			// The row vanished between the failed claim and the re-read
			// (expiry, or a retention sweep). Retrying is safe and correct.
			return "", errConflict("Concurrent request with the same idempotency key; retry")
		}
		return eventID, nil
	}

	metrics.EventsIngested.WithLabelValues(key.ProjectEnvironment).Inc()
	return eventID, nil
}

// requestMetadata is the small JSON object stored in events.headers.
//
// ordering_key lives here because the events table has no column for it yet;
// the router reads it when materialising deliveries, which DO have one. See
// HANDOFF.md - this wants a first-class column.
func requestMetadata(envelope *Envelope) ([]byte, error) {
	meta := map[string]string{}
	if envelope.OrderingKey != "" {
		meta["ordering_key"] = envelope.OrderingKey
	}
	if len(meta) == 0 {
		return nil, nil
	}
	return json.Marshal(meta)
}

// touchKey records last use out of band. It is deliberately fire-and-forget and
// throttled: a write per request would double the write load of the hot path to
// maintain a column nobody reads in real time.
func (h *Handler) touchKey(keyID string) {
	if !h.touch.should(keyID, h.now()) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := h.store.TouchAPIKey(ctx, keyID); err != nil {
			h.log.Debug("touch api key failed", "error", err.Error())
		}
	}()
}

// touchThrottle rate limits last_used_at writes to one per key per interval.
type touchThrottle struct {
	mu       sync.Mutex
	interval time.Duration
	seen     map[string]time.Time
}

// maxTrackedKeys bounds the map. A project rotating keys endlessly must not
// turn this into a leak; dropping the table costs one extra write per key.
const maxTrackedKeys = 10000

func newTouchThrottle(interval time.Duration) *touchThrottle {
	return &touchThrottle{interval: interval, seen: make(map[string]time.Time)}
}

func (t *touchThrottle) should(keyID string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if last, ok := t.seen[keyID]; ok && now.Sub(last) < t.interval {
		return false
	}
	if len(t.seen) >= maxTrackedKeys {
		t.seen = make(map[string]time.Time)
	}
	t.seen[keyID] = now
	return true
}

// parseEventsPath matches /v1/projects/{project_id}/events. Hand-parsed because
// Go 1.21's ServeMux has no path parameters, and because the project ID must be
// checked for shape before it is used in a query.
func parseEventsPath(path string) (string, bool) {
	trimmed := strings.Trim(path, "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 4 || parts[0] != "v1" || parts[1] != "projects" || parts[3] != "events" {
		return "", false
	}
	projectID := parts[2]
	if _, err := ids.Parse(projectID, ids.Project); err != nil {
		return "", false
	}
	return projectID, true
}
