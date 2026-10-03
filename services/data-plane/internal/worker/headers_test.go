package worker

import (
	"strings"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/signing"
)

func headerInput() HeaderInput {
	return HeaderInput{
		EventID:    "evt_01J",
		DeliveryID: "del_01J",
		EventType:  "order.created",
		Attempt:    2,
		Timestamp:  time.Unix(1757155200, 0),
		Signature:  "t=1757155200,v1=abc,v1=def",
	}
}

func TestBuildHeadersMatchesTheDocumentedContract(t *testing.T) {
	h := BuildHeaders(headerInput())

	want := map[string]string{
		"Webhook-Id":          "evt_01J",
		"Webhook-Delivery-Id": "del_01J",
		"Webhook-Event-Type":  "order.created",
		"Webhook-Attempt":     "2",
		"Webhook-Timestamp":   "1757155200",
		"Webhook-Signature":   "t=1757155200,v1=abc,v1=def",
		"Content-Type":        "application/json",
	}
	for name, value := range want {
		if got := h.Get(name); got != value {
			t.Fatalf("%s = %q, want %q (docs/API.md)", name, got, value)
		}
	}
	if h.Get("User-Agent") == "" {
		t.Fatal("no User-Agent; the endpoint's logs and WAF have nothing to identify us by")
	}
}

// The whole reason platform headers are set last.
func TestCustomHeadersCannotOverrideTheSignature(t *testing.T) {
	in := headerInput()
	in.Custom = map[string]string{
		"Webhook-Signature":   "t=1,v1=forged",
		"webhook-signature":   "t=1,v1=forged-lowercase",
		"WEBHOOK-SIGNATURE":   "t=1,v1=forged-uppercase",
		"Webhook-Id":          "evt_attacker",
		"Webhook-Delivery-Id": "del_attacker",
		"Webhook-Event-Type":  "attacker.event",
		"Webhook-Attempt":     "999",
		"Webhook-Timestamp":   "1",
	}
	h := BuildHeaders(in)

	if got := h.Values("Webhook-Signature"); len(got) != 1 {
		t.Fatalf("Webhook-Signature has %d values %q; a second, customer-controlled v1 set would be accepted by any consumer that checks 'any v1 matches'", len(got), got)
	}
	if got := h.Get("Webhook-Signature"); got != in.Signature {
		t.Fatalf("Webhook-Signature = %q, want the platform signature %q", got, in.Signature)
	}
	for name, want := range map[string]string{
		"Webhook-Id":          "evt_01J",
		"Webhook-Delivery-Id": "del_01J",
		"Webhook-Event-Type":  "order.created",
		"Webhook-Attempt":     "2",
		"Webhook-Timestamp":   "1757155200",
	} {
		if got := h.Get(name); got != want {
			t.Fatalf("%s = %q, want %q; a custom header overrode a platform header", name, got, want)
		}
		if len(h.Values(name)) != 1 {
			t.Fatalf("%s was appended to rather than overwritten: %q", name, h.Values(name))
		}
	}
}

func TestCustomHeadersAreOtherwiseHonoured(t *testing.T) {
	in := headerInput()
	in.Custom = map[string]string{
		"X-Tenant":      "acme",
		"Authorization": "Bearer customer-token",
		"Content-Type":  "application/vnd.acme+json",
	}
	h := BuildHeaders(in)

	if got := h.Get("X-Tenant"); got != "acme" {
		t.Fatalf("X-Tenant = %q, want acme", got)
	}
	if got := h.Get("Authorization"); got != "Bearer customer-token" {
		t.Fatalf("the endpoint's own credential must still be sent, got %q", got)
	}
	if got := h.Get("Content-Type"); got != "application/vnd.acme+json" {
		t.Fatalf("Content-Type = %q; it is not a platform header and may be overridden", got)
	}
}

func TestReservedTransportHeadersAreDropped(t *testing.T) {
	in := headerInput()
	in.Custom = map[string]string{
		"Host":              "evil.example",
		"Content-Length":    "0",
		"Transfer-Encoding": "chunked",
		"Connection":        "close",
	}
	h := BuildHeaders(in)
	for _, name := range []string{"Host", "Content-Length", "Transfer-Encoding", "Connection"} {
		if got := h.Get(name); got != "" {
			t.Fatalf("%s = %q; letting a config field set a transport header is a smuggling primitive", name, got)
		}
	}
}

func TestHeaderInjectionIsRejected(t *testing.T) {
	in := headerInput()
	in.Custom = map[string]string{
		"X-Bad":               "value\r\nWebhook-Signature: t=1,v1=forged",
		"X-Null":              "value\x00",
		"Bad: Name":           "value",
		"X-Newline-In-Name\n": "value",
	}
	h := BuildHeaders(in)

	if len(h.Values("Webhook-Signature")) != 1 || h.Get("Webhook-Signature") != in.Signature {
		t.Fatalf("CRLF in a header value smuggled a signature: %q", h.Values("Webhook-Signature"))
	}
	for _, name := range []string{"X-Bad", "X-Null"} {
		if got := h.Get(name); got != "" {
			t.Fatalf("%s = %q; a value carrying CR, LF or NUL must be dropped", name, got)
		}
	}
	for name, values := range h {
		if strings.ContainsAny(name, " \r\n:") {
			t.Fatalf("header name %q is not a token: %q", name, values)
		}
	}
}

func TestSignatureCoversTheExactPayloadBytes(t *testing.T) {
	// Key ordering and whitespace that PostgreSQL's jsonb would normalise away.
	payload := []byte("{ \"b\": 1,  \"a\": 2 }")
	ts := time.Unix(1757155200, 0)

	header, err := signing.Header([]string{"secret-one", "secret-two"}, payload, ts)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	in := headerInput()
	in.Signature = header
	in.Timestamp = ts
	h := BuildHeaders(in)

	for _, secret := range []string{"secret-one", "secret-two"} {
		if err := signing.Verify(h.Get("Webhook-Signature"), secret, payload, 5*time.Minute, ts); err != nil {
			t.Fatalf("rotation overlap: a consumer holding %q could not verify: %v", secret, err)
		}
	}
	// The normalised form a jsonb round trip would produce must NOT verify -
	// that is the failure mode payload_raw exists to prevent.
	if err := signing.Verify(h.Get("Webhook-Signature"), "secret-one", []byte(`{"a": 2, "b": 1}`), 5*time.Minute, ts); err == nil {
		t.Fatal("a re-serialised payload verified; the signature is not over the exact bytes")
	}
	if h.Get("Webhook-Timestamp") != "1757155200" {
		t.Fatalf("Webhook-Timestamp must be the timestamp inside the signature, got %q", h.Get("Webhook-Timestamp"))
	}
}

func TestRedactHeadersHidesCredentialsButKeepsTheSignature(t *testing.T) {
	in := headerInput()
	in.Custom = map[string]string{
		"Authorization": "Bearer customer-token",
		"X-Api-Key":     "xx_live_placeholder",
		"Cookie":        "session=abc",
		"X-Tenant":      "acme",
	}
	redacted := RedactHeaders(BuildHeaders(in))

	for _, name := range []string{"Authorization", "X-Api-Key", "Cookie"} {
		if got := redacted[name]; got != "[redacted]" {
			t.Fatalf("%s = %q; a live credential must never reach the delivery ledger", name, got)
		}
	}
	if redacted["X-Tenant"] != "acme" {
		t.Fatalf("a harmless header was redacted: %q", redacted["X-Tenant"])
	}
	if redacted["Webhook-Signature"] != in.Signature {
		t.Fatalf("the signature must stay readable in the ledger; it is what anyone debugging verification needs")
	}
}
