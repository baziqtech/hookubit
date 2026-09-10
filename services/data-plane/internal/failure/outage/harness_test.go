package outage_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/db"
	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
)

// ---------------------------------------------------------------------------
// Outage simulation
// ---------------------------------------------------------------------------

// tcpProxy is an in-process TCP relay that a test puts in front of a real
// server so it can take that server away and give it back.
//
// This is the whole reason the outage tests do not touch the developer's
// PostgreSQL: `docker stop` would be a far more faithful simulation and is
// completely unusable, because every other test package - and, in this
// workspace, other agents - is talking to the same instance. Closing a relay
// this process owns produces the same thing the pool sees (connections severed,
// new dials refused) and affects nobody else.
//
// down() severs every relayed connection as well as closing the listener: a
// database that has gone away does not politely drain the sockets it was
// serving, and a pool holding an idle-but-dead connection is precisely the
// state that separates "fails fast with an error" from "hangs".
type tcpProxy struct {
	upstream string

	mu    sync.Mutex
	addr  string
	ln    net.Listener
	conns map[net.Conn]struct{}
	// cutAfter, when positive, severs everything after that many further
	// client-to-server writes. It is how a test lands an outage INSIDE a
	// transaction rather than hoping a sleep is short enough.
	cutAfter int
}

func newTCPProxy(t *testing.T, upstream string) *tcpProxy {
	t.Helper()
	p := &tcpProxy{upstream: upstream, conns: map[net.Conn]struct{}{}}
	p.up(t)
	t.Cleanup(p.down)
	return p
}

// up starts, or restarts, the relay. The first call picks a port; every later
// call re-binds the SAME port, which is what makes recovery observable to a
// pool that has been pointing at that address the whole time.
func (p *tcpProxy) up(t *testing.T) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ln != nil {
		return
	}
	bind := p.addr
	if bind == "" {
		bind = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", bind)
	if err != nil {
		t.Fatalf("start tcp relay on %s: %v", bind, err)
	}
	p.ln = ln
	p.addr = ln.Addr().String()
	go p.accept(ln)
}

// down is the outage: no new connections, and the existing ones are cut.
func (p *tcpProxy) down() {
	p.mu.Lock()
	ln := p.ln
	p.ln = nil
	open := make([]net.Conn, 0, len(p.conns))
	for c := range p.conns {
		open = append(open, c)
	}
	p.conns = map[net.Conn]struct{}{}
	p.mu.Unlock()

	if ln != nil {
		_ = ln.Close()
	}
	for _, c := range open {
		_ = c.Close()
	}
}

// address is where callers should point their DSN.
func (p *tcpProxy) address() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.addr
}

func (p *tcpProxy) accept(ln net.Listener) {
	for {
		client, err := ln.Accept()
		if err != nil {
			return
		}
		go p.relay(client)
	}
}

func (p *tcpProxy) relay(client net.Conn) {
	server, err := net.DialTimeout("tcp", p.upstream, 5*time.Second)
	if err != nil {
		_ = client.Close()
		return
	}
	p.track(client, server)
	defer p.drop(client, server)

	done := make(chan struct{}, 2)
	go func() { p.copyFromClient(server, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, server); done <- struct{}{} }()
	<-done
}

// copyFromClient is io.Copy with the cut counter applied: each message the
// client sends is forwarded, and when an armed countdown reaches zero the whole
// relay goes down mid-conversation.
func (p *tcpProxy) copyFromClient(server, client net.Conn) {
	buf := make([]byte, 32<<10)
	for {
		n, readErr := client.Read(buf)
		if n > 0 {
			if _, writeErr := server.Write(buf[:n]); writeErr != nil {
				return
			}
			if p.chargeCut() {
				p.down()
				return
			}
		}
		if readErr != nil {
			return
		}
	}
}

// armCut schedules the outage for after n further client messages. n <= 0
// disarms it.
func (p *tcpProxy) armCut(n int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cutAfter = n
}

// chargeCut counts one forwarded client message and reports whether this is the
// one that triggers the outage.
func (p *tcpProxy) chargeCut() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cutAfter <= 0 {
		return false
	}
	p.cutAfter--
	if p.cutAfter > 0 {
		return false
	}
	p.cutAfter = 0
	return true
}

func (p *tcpProxy) track(conns ...net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range conns {
		p.conns[c] = struct{}{}
	}
}

func (p *tcpProxy) drop(conns ...net.Conn) {
	p.mu.Lock()
	for _, c := range conns {
		delete(p.conns, c)
	}
	p.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// closedPort returns an address on loopback that nothing is listening on, for
// the tests that need a dial to be refused immediately rather than to hang.
func closedPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("release the reserved port: %v", err)
	}
	return addr
}

// ---------------------------------------------------------------------------
// Database plumbing
// ---------------------------------------------------------------------------

// databaseTimeout bounds every accept in these tests. It is deliberately much
// shorter than ingest.DefaultDBTimeout so an injected outage costs the suite
// milliseconds; the production value is 5s and is what INGEST_DB_TIMEOUT_MS
// sets.
const databaseTimeout = 750 * time.Millisecond

// directPool is the honest pool: it talks to PostgreSQL without going through
// the relay, so an assertion about what is actually committed cannot be
// confused by the outage the test just injected.
func directPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return testsupport.Pool(t)
}

// proxiedPool is the pool under test: everything it does reaches PostgreSQL
// through a relay the test can close.
func proxiedPool(t *testing.T, proxy *tcpProxy, dsn string, maxConns int32) *pgxpool.Pool {
	t.Helper()
	pool, err := db.Open(context.Background(), rehost(t, dsn, proxy.address()), maxConns, 5*time.Second)
	if err != nil {
		t.Fatalf("open pool through the relay: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// rehost rewrites a DSN to point at another address, keeping every other
// parameter (credentials, database name, sslmode) exactly as it was.
func rehost(t *testing.T, dsn, addr string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	u.Host = addr
	return u.String()
}

// upstreamOf extracts host:port from a DSN, which is where the relay dials.
func upstreamOf(t *testing.T, dsn string) string {
	t.Helper()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	return net.JoinHostPort(u.Hostname(), port)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// tenant is one organisation/project/key/endpoint/event, seeded through the
// direct pool. Everything the outage tests assert about durability is asserted
// against rows this seeded.
type tenant struct {
	pool *pgxpool.Pool

	orgID      string
	projectID  string
	keyID      string
	apiKey     string
	endpointID string
	policyID   string
	eventID    string
	payload    []byte
}

func seedTenant(t *testing.T, pool *pgxpool.Pool) *tenant {
	t.Helper()
	suffix, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := ids.Token(16)
	if err != nil {
		t.Fatal(err)
	}

	f := &tenant{
		pool:       pool,
		orgID:      ids.New(ids.Organization),
		projectID:  ids.New(ids.Project),
		keyID:      ids.New(ids.APIKey),
		endpointID: ids.New(ids.Endpoint),
		policyID:   ids.New(ids.RetryPolicy),
		eventID:    ids.New(ids.Event),
		apiKey:     "wk_test_" + secret,
		payload:    []byte(`{ "event_type":"order.created", "data":{"b":1,"a":2} }`),
	}

	exec(t, pool, `INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
	               VALUES ($1, 'outage test', $2, 'active', now(), now())`,
		f.orgID, "outage-"+suffix)
	exec(t, pool, `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
	               VALUES ($1, $2, 'outage test', $3, 'test', 'active', now(), now())`,
		f.projectID, f.orgID, "outage-"+suffix)
	exec(t, pool, `INSERT INTO api_keys (id, project_id, name, key_hash, key_prefix, scopes, environment, created_at, updated_at)
	               VALUES ($1, $2, 'outage test', $3, $4, ARRAY['events:write'], 'test', now(), now())`,
		f.keyID, f.projectID, ingest.HashKey(f.apiKey), ingest.KeyPrefix(f.apiKey))
	exec(t, pool, `INSERT INTO retry_policies
	                 (id, project_id, name, is_default, strategy, max_attempts, initial_delay_ms,
	                  max_delay_ms, multiplier, jitter_ratio, max_retry_duration_ms, created_at, updated_at)
	               VALUES ($1, $2, 'outage test', false, 'exponential', 6, 1000, 60000, 2, 0.1, 7200000, now(), now())`,
		f.policyID, f.projectID)
	exec(t, pool, `INSERT INTO endpoints
	                 (id, project_id, name, url, status, enabled, timeout_ms, max_concurrency,
	                  rate_limit, rate_limit_window_seconds, retry_policy_id, created_at, updated_at)
	               VALUES ($1, $2, 'outage test', 'https://example.com/hook', 'active', true, 9000, 4,
	                       0, 1, $3, now(), now())`,
		f.endpointID, f.projectID, f.policyID)
	exec(t, pool, `INSERT INTO events
	                 (id, organization_id, project_id, event_type, payload, payload_raw,
	                  payload_size, payload_hash, status, created_at)
	               VALUES ($1, $2, $3, 'order.created', $4::jsonb, $5, $6, $7, 'received', now())`,
		f.eventID, f.orgID, f.projectID, string(f.payload), f.payload, len(f.payload), ingest.HashPayload(f.payload))

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM deliveries WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM event_outbox WHERE event_id IN (SELECT id FROM events WHERE organization_id = $1)`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM events WHERE organization_id = $1`, f.orgID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoint_health WHERE endpoint_id = $1`, f.endpointID)
		_, _ = pool.Exec(bg, `DELETE FROM endpoints WHERE id = $1`, f.endpointID)
		_, _ = pool.Exec(bg, `DELETE FROM retry_policies WHERE id = $1`, f.policyID)
		_, _ = pool.Exec(bg, `DELETE FROM organizations WHERE id = $1`, f.orgID)
	})
	return f
}

// newEvent seeds an additional event, so a test can create more than one
// delivery without them sharing a row.
func (f *tenant) newEvent(t *testing.T) string {
	t.Helper()
	id := ids.New(ids.Event)
	exec(t, f.pool, `INSERT INTO events
	                   (id, organization_id, project_id, event_type, payload, payload_raw,
	                    payload_size, payload_hash, status, created_at)
	                 VALUES ($1, $2, $3, 'order.created', $4::jsonb, $5, $6, $7, 'received', now())`,
		id, f.orgID, f.projectID, string(f.payload), f.payload, len(f.payload), ingest.HashPayload(f.payload))
	return id
}

// insertDelivery writes one delivery row that is ready to be claimed now.
// lockedBy/lease are for the tests that need a row already leased.
func (f *tenant) insertDelivery(t *testing.T, status, lockedBy string, lease time.Duration) string {
	t.Helper()
	id := ids.New(ids.Delivery)
	var by, until any
	if lockedBy != "" {
		by = lockedBy
		until = time.Now().Add(lease).UTC()
	}
	exec(t, f.pool, `INSERT INTO deliveries
	                   (id, event_id, endpoint_id, organization_id, project_id, status,
	                    attempt_count, max_attempts, next_attempt_at, locked_by, locked_until,
	                    created_at, updated_at)
	                 VALUES ($1, $2, $3, $4, $5, $6::text::"DeliveryStatus", 0, 6, now(), $7, $8, now(), now())`,
		id, f.newEvent(t), f.endpointID, f.orgID, f.projectID, status, by, until)
	return id
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("seed failed (%s...): %v", strings.TrimSpace(sql)[:40], err)
	}
}

func scalar[T any](t *testing.T, pool *pgxpool.Pool, sql string, args ...any) T {
	t.Helper()
	var out T
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&out); err != nil {
		t.Fatalf("query (%s...): %v", strings.TrimSpace(sql)[:40], err)
	}
	return out
}

// ---------------------------------------------------------------------------
// Ingest plumbing
// ---------------------------------------------------------------------------

// postEvent runs one ingest request against a handler and returns the recorder.
func postEvent(t *testing.T, h *ingest.Handler, projectID, apiKey, idempotencyKey, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/projects/"+projectID+"/events", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const eventBody = `{"event_type":"order.created","data":{"order_id":"ord_outage"}}`

// generousPayloadLimits keep every body in these tests inline, so object
// storage is never on the path of a test about PostgreSQL or Redis.
func generousPayloadLimits() ingest.PayloadLimits {
	return ingest.PayloadLimits{InlineMax: 1 << 20, Max: 1 << 20}
}

func idempotencyKey(t *testing.T) string {
	t.Helper()
	token, err := ids.Token(8)
	if err != nil {
		t.Fatal(err)
	}
	return "outage_" + token
}

func requireStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, want, strings.TrimSpace(rec.Body.String()))
	}
}

func errorCodeOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body ingest.ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error response is not the documented envelope: %v (%s)", err, rec.Body.String())
	}
	return body.Error.Code
}

func acceptedIDOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body ingest.AcceptedBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("202 response is not the documented envelope: %v (%s)", err, rec.Body.String())
	}
	if body.Status != "accepted" {
		t.Fatalf("202 body status = %q, want \"accepted\"", body.Status)
	}
	return body.ID
}

// countEvents, countOutbox and countIdempotencyClaims are read through the
// DIRECT pool: they are what the database says, independent of whatever the
// pool under test believes.
func countEvents(t *testing.T, pool *pgxpool.Pool, eventID string) int {
	t.Helper()
	return scalar[int](t, pool, `SELECT count(*)::int FROM events WHERE id = $1`, eventID)
}

func countOutbox(t *testing.T, pool *pgxpool.Pool, eventID string) int {
	t.Helper()
	return scalar[int](t, pool, `SELECT count(*)::int FROM event_outbox WHERE event_id = $1`, eventID)
}

func countIdempotencyClaims(t *testing.T, pool *pgxpool.Pool, projectID, key string) int {
	t.Helper()
	return scalar[int](t, pool,
		`SELECT count(*)::int FROM idempotency_keys WHERE project_id = $1 AND "key" = $2`, projectID, key)
}

// testWriter routes a handler's own logs into the test output, so a failure
// shows what the code under test complained about at the time.
type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("service log: %s", strings.TrimSpace(string(p)))
	return len(p), nil
}

// jsonDecode is the concurrency-safe spelling of the body decoders above: it
// takes no *testing.T, so it can be called from a goroutine.
func jsonDecode(raw []byte, into any) error { return json.Unmarshal(raw, into) }
