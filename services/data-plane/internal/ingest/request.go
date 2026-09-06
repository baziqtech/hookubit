package ingest

import (
	"encoding/json"
	"strings"
	"unicode"
)

// Envelope is the accepted request body. It is decoded only to validate and to
// pull out routing fields; the bytes that are persisted and later signed are
// always the raw ones, never a re-encoding of this struct.
type Envelope struct {
	EventType   string          `json:"event_type"`
	Data        json.RawMessage `json:"data"`
	OrderingKey string          `json:"ordering_key"`
}

const (
	maxEventTypeLength   = 255
	maxOrderingKeyLength = 255
	maxIdempotencyKeyLen = 255
)

// ParseEnvelope validates the request body and returns the decoded envelope.
//
// Unknown fields are rejected: a client that misspells `event_type` should
// learn that now, not by wondering why nothing was ever delivered.
func ParseEnvelope(body []byte) (*Envelope, *apiError) {
	if len(body) == 0 {
		return nil, errInvalidRequest("Request body is required")
	}

	var env Envelope
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		// The decoder's message can quote body content, which may be customer
		// data; keep the response generic and structural.
		return nil, errInvalidRequest("Request body must be a JSON object with the documented fields")
	}
	if dec.More() {
		return nil, errInvalidRequest("Request body must contain exactly one JSON object")
	}

	if err := validateEventType(env.EventType); err != nil {
		return nil, err
	}
	if err := validateOrderingKey(env.OrderingKey); err != nil {
		return nil, err
	}
	if len(env.Data) == 0 {
		return nil, errInvalidRequest("data is required")
	}
	if err := rejectNUL(body); err != nil {
		return nil, err
	}
	return &env, nil
}

// rejectNUL refuses a body carrying a NUL character.
//
// A \u0000 escape is valid JSON and json.Decoder accepts it, but PostgreSQL's
// jsonb cannot represent it and the INSERT fails with "unsupported Unicode
// escape sequence". Without this check that failure surfaces as a 500 from
// persist, the transaction rolls back so the idempotency claim never lands, and
// the client's retry loop gets the identical 500 forever - one connection and
// one transaction burned per retry for what is a client-side bug.
//
// It is a client error, so it is caught in validation and answered
// invalid_request. events.payload_raw (bytea) could hold these bytes, but
// events.payload is still jsonb, so the check is required regardless.
func rejectNUL(body []byte) *apiError {
	const message = `Payload must not contain a NUL character (\u0000): it cannot be stored`
	for i := 0; i < len(body); i++ {
		if body[i] == 0x00 {
			return errInvalidRequest(message)
		}
		if body[i] != '\\' || i+1 >= len(body) {
			continue
		}
		// Consume the whole escape. Skipping both bytes is what keeps an
		// escaped backslash followed by the literal text u0000 from being read
		// as a NUL escape.
		if body[i+1] == 'u' && i+5 < len(body) && string(body[i+2:i+6]) == "0000" {
			return errInvalidRequest(message)
		}
		i++
	}
	return nil
}

func validateEventType(eventType string) *apiError {
	if eventType == "" {
		return errInvalidRequest("event_type is required")
	}
	if len(eventType) > maxEventTypeLength {
		return errInvalidRequest("event_type must be at most 255 characters")
	}
	// The routing patterns in internal/router are dot-segmented ("payment.*"),
	// so an event type containing a wildcard or whitespace would make a filter
	// mean something other than it reads.
	for _, r := range eventType {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-', r == ':':
		default:
			return errInvalidRequest("event_type may contain only letters, digits, and . _ - :")
		}
	}
	if strings.HasPrefix(eventType, ".") || strings.HasSuffix(eventType, ".") {
		return errInvalidRequest("event_type must not begin or end with a dot")
	}
	return nil
}

func validateOrderingKey(key string) *apiError {
	if key == "" {
		return nil
	}
	if len(key) > maxOrderingKeyLength {
		return errInvalidRequest("ordering_key must be at most 255 characters")
	}
	if !isPrintableASCII(key) {
		return errInvalidRequest("ordering_key must be printable ASCII")
	}
	return nil
}

// ValidateIdempotencyKey guards the header before it is used as part of a
// unique index value.
func ValidateIdempotencyKey(key string) *apiError {
	if key == "" {
		return nil
	}
	if len(key) > maxIdempotencyKeyLen {
		return errInvalidRequest("Idempotency-Key must be at most 255 characters")
	}
	if !isPrintableASCII(key) {
		return errInvalidRequest("Idempotency-Key must be printable ASCII")
	}
	return nil
}

func isPrintableASCII(s string) bool {
	for _, r := range s {
		if r > unicode.MaxASCII || !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}

// isJSONContentType accepts application/json and its +json suffixes, with or
// without parameters. An empty header is accepted: plenty of clients omit it on
// a body they have already declared by posting to a JSON API.
func isJSONContentType(header string) bool {
	if header == "" {
		return true
	}
	mediaType := strings.TrimSpace(strings.ToLower(header))
	if idx := strings.IndexByte(mediaType, ';'); idx >= 0 {
		mediaType = strings.TrimSpace(mediaType[:idx])
	}
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}
