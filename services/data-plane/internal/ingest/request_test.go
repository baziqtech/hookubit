package ingest

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestParseEnvelopeAcceptsTheDocumentedShape(t *testing.T) {
	body := []byte(`{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.50},"ordering_key":"customer_123"}`)
	env, err := ParseEnvelope(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env.EventType != "order.created" {
		t.Fatalf("event_type = %q", env.EventType)
	}
	if env.OrderingKey != "customer_123" {
		t.Fatalf("ordering_key = %q", env.OrderingKey)
	}
	if len(env.Data) == 0 {
		t.Fatal("data was dropped")
	}
}

func TestParseEnvelopeOrderingKeyIsOptional(t *testing.T) {
	if _, err := ParseEnvelope([]byte(`{"event_type":"order.created","data":{}}`)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParseEnvelopeRejections(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty body", ``},
		{"not json", `not json at all`},
		{"json array", `[{"event_type":"a.b","data":{}}]`},
		{"missing event_type", `{"data":{}}`},
		{"empty event_type", `{"event_type":"","data":{}}`},
		{"missing data", `{"event_type":"order.created"}`},
		{"unknown field", `{"event_type":"order.created","data":{},"typo":1}`},
		{"trailing object", `{"event_type":"a.b","data":{}}{"event_type":"c.d","data":{}}`},
		{"wildcard in event_type", `{"event_type":"order.*","data":{}}`},
		{"space in event_type", `{"event_type":"order created","data":{}}`},
		{"leading dot", `{"event_type":".created","data":{}}`},
		{"trailing dot", `{"event_type":"order.","data":{}}`},
		{"event_type too long", `{"event_type":"` + strings.Repeat("a", 256) + `","data":{}}`},
		{"ordering_key too long", `{"event_type":"a.b","data":{},"ordering_key":"` + strings.Repeat("k", 256) + `"}`},
		{"ordering_key not printable", "{\"event_type\":\"a.b\",\"data\":{},\"ordering_key\":\"a\\u0000b\"}"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseEnvelope([]byte(tc.body))
			if err == nil {
				t.Fatal("expected a rejection")
			}
			if err.Code != CodeInvalidRequest || err.Status != 400 {
				t.Fatalf("got %s/%d, want invalid_request/400", err.Code, err.Status)
			}
		})
	}
}

// The decoder's own error text can quote body content, which may be customer
// data. It must not become the public message.
func TestParseEnvelopeErrorDoesNotEchoTheBody(t *testing.T) {
	_, err := ParseEnvelope([]byte(`{"event_type":"a.b","data":{},"card_number":"4111111111111111"}`))
	if err == nil {
		t.Fatal("expected a rejection")
	}
	if strings.Contains(err.Message, "4111111111111111") || strings.Contains(err.Message, "card_number") {
		t.Fatalf("error message leaked body content: %q", err.Message)
	}
}

func TestValidateIdempotencyKey(t *testing.T) {
	if err := ValidateIdempotencyKey(""); err != nil {
		t.Fatalf("an absent key is valid, got %v", err)
	}
	if err := ValidateIdempotencyKey("order_123_created_v1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidateIdempotencyKey(strings.Repeat("k", 256)); err == nil {
		t.Fatal("expected a rejection for an over-long key")
	}
	if err := ValidateIdempotencyKey("bad\nkey"); err == nil {
		t.Fatal("expected a rejection for a non-printable key")
	}
}

func TestIsJSONContentType(t *testing.T) {
	cases := map[string]bool{
		"":                                  true,
		"application/json":                  true,
		"application/json; charset=utf-8":   true,
		"APPLICATION/JSON":                  true,
		"application/vnd.shaq.event+json":   true,
		"text/plain":                        false,
		"application/x-www-form-urlencoded": false,
	}
	for header, want := range cases {
		if got := isJSONContentType(header); got != want {
			t.Fatalf("isJSONContentType(%q) = %v, want %v", header, got, want)
		}
	}
}

// A \u0000 escape is valid JSON, so the decoder accepts it - but jsonb cannot
// store it and the INSERT fails with "unsupported Unicode escape sequence".
// Catching it in validation is what keeps a client-side bug from being answered
// with a permanent 500 (and a burnt transaction) on every retry.
func TestParseEnvelopeRejectsNULEscape(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"in a value", `{"event_type":"order.created","data":{"note":"a\u0000b"}}`},
		{"in a key", `{"event_type":"order.created","data":{"a\u0000b":1}}`},
		{"nested", `{"event_type":"order.created","data":{"a":{"b":["\u0000"]}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Sanity: the body really is valid JSON, so this is our rejection,
			// not the decoder's.
			if !json.Valid([]byte(tc.body)) {
				t.Fatal("test body is not valid JSON")
			}
			_, apiErr := ParseEnvelope([]byte(tc.body))
			if apiErr == nil {
				t.Fatal("a NUL escape was accepted")
			}
			if apiErr.Code != CodeInvalidRequest || apiErr.Status != http.StatusBadRequest {
				t.Fatalf("error = %d/%s, want 400/invalid_request", apiErr.Status, apiErr.Code)
			}
		})
	}
}

// The escape must be read the way JSON reads it: a backslash that is itself
// escaped does not start a \u escape, so this body is legal and must pass.
func TestParseEnvelopeAcceptsEscapedBackslashBeforeU0000(t *testing.T) {
	body := `{"event_type":"order.created","data":{"path":"c:\\u0000ops"}}`
	if !json.Valid([]byte(body)) {
		t.Fatal("test body is not valid JSON")
	}
	if _, apiErr := ParseEnvelope([]byte(body)); apiErr != nil {
		t.Fatalf("literal text u0000 after an escaped backslash was rejected: %v", apiErr)
	}
}
