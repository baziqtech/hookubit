package worker

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/signing"
)

// The platform headers documented in docs/API.md. Consumers verify against
// these names, so they are part of the public contract and a customer's
// custom_headers must never be able to shadow one.
const (
	HeaderEventID    = "Webhook-Id"
	HeaderDeliveryID = "Webhook-Delivery-Id"
	HeaderEventType  = "Webhook-Event-Type"
	HeaderAttempt    = "Webhook-Attempt"
	HeaderTimestamp  = "Webhook-Timestamp"
	HeaderSignature  = signing.HeaderName // "Webhook-Signature"
)

// UserAgent identifies the platform to the endpoint's logs and WAF.
const UserAgent = "ShaQ-Webhooks/1.0"

// platformHeaders is the set a customer cannot set, override or remove. The
// signature is the one that matters: an endpoint whose custom_headers included
// `Webhook-Signature: v1=whatever` could otherwise make the platform ship a
// forged signature over a genuine payload, and every consumer verifying "any
// v1 matches" would still be looking at a header the customer wrote.
var platformHeaders = map[string]struct{}{
	http.CanonicalHeaderKey(HeaderEventID):    {},
	http.CanonicalHeaderKey(HeaderDeliveryID): {},
	http.CanonicalHeaderKey(HeaderEventType):  {},
	http.CanonicalHeaderKey(HeaderAttempt):    {},
	http.CanonicalHeaderKey(HeaderTimestamp):  {},
	http.CanonicalHeaderKey(HeaderSignature):  {},
}

// reservedHeaders are owned by the transport. Letting a customer set them turns
// a config field into a request-smuggling primitive.
var reservedHeaders = map[string]struct{}{
	"Host":              {},
	"Content-Length":    {},
	"Transfer-Encoding": {},
	"Connection":        {},
	"Upgrade":           {},
	"Te":                {},
	"Trailer":           {},
	"Expect":            {},
}

// HeaderInput is everything one delivery's headers are built from.
type HeaderInput struct {
	EventID    string
	DeliveryID string
	EventType  string
	Attempt    int
	Timestamp  time.Time
	Signature  string
	// Custom is endpoints.custom_headers. Applied FIRST so that every platform
	// header, set afterwards, wins.
	Custom map[string]string
	// ContentType defaults to application/json. Unlike the platform headers
	// this one a customer may override: the signature covers the body bytes,
	// not the media type, so nothing verifiable depends on it.
	ContentType string
}

// BuildHeaders assembles the outbound header set.
//
// Order is the entire security property: customer headers go on first, the
// platform headers go on last with Set (not Add), so a collision is overwritten
// rather than appended. Appending would be worse than useless - two
// Webhook-Signature values, one of them customer-controlled.
func BuildHeaders(in HeaderInput) http.Header {
	h := make(http.Header, len(in.Custom)+8)

	for name, value := range in.Custom {
		canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
		if canonical == "" || !validHeaderName(canonical) || !validHeaderValue(value) {
			continue
		}
		if _, reserved := reservedHeaders[canonical]; reserved {
			continue
		}
		if _, platform := platformHeaders[canonical]; platform {
			continue
		}
		h.Set(canonical, value)
	}

	contentType := in.ContentType
	if contentType == "" {
		contentType = "application/json"
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", contentType)
	}
	if h.Get("User-Agent") == "" {
		h.Set("User-Agent", UserAgent)
	}
	if h.Get("Accept") == "" {
		h.Set("Accept", "*/*")
	}

	// Platform headers last, unconditionally.
	h.Set(HeaderEventID, in.EventID)
	h.Set(HeaderDeliveryID, in.DeliveryID)
	h.Set(HeaderEventType, in.EventType)
	h.Set(HeaderAttempt, strconv.Itoa(in.Attempt))
	h.Set(HeaderTimestamp, strconv.FormatInt(in.Timestamp.Unix(), 10))
	h.Set(HeaderSignature, in.Signature)
	return h
}

// validHeaderName accepts RFC 7230 tokens only. A name containing a colon,
// space or control character is header injection, not a typo.
func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		if !isTokenByte(name[i]) {
			return false
		}
	}
	return true
}

func isTokenByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	switch c {
	case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
		return true
	}
	return false
}

// validHeaderValue rejects CR, LF and NUL. Those three bytes are the whole of
// response splitting and request smuggling via a config field.
func validHeaderValue(v string) bool {
	for i := 0; i < len(v); i++ {
		switch v[i] {
		case '\r', '\n', 0:
			return false
		}
	}
	return true
}

// sensitiveHeaderNames are redacted before request headers are written to the
// delivery ledger. custom_headers routinely carries the customer's own bearer
// token for their endpoint; storing that in delivery_attempts would put a live
// credential in a table the operator UI renders (engineering rule 12).
//
// Webhook-Signature is deliberately NOT redacted: it is derived from the secret
// but does not reveal it, and it is the first thing anyone debugging "my
// verification fails" needs to see.
var sensitiveHeaderNames = []string{
	"authorization", "proxy-authorization", "cookie", "set-cookie",
	"api-key", "apikey", "secret", "token", "password", "credential",
}

// RedactHeaders returns a copy safe to persist. Values are replaced, never
// dropped, so the ledger still shows that the header was sent.
func RedactHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for name, values := range h {
		value := strings.Join(values, ", ")
		if isSensitiveHeader(name) {
			value = "[redacted]"
		}
		out[name] = value
	}
	return out
}

func isSensitiveHeader(name string) bool {
	lower := strings.ToLower(name)
	for _, needle := range sensitiveHeaderNames {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}
