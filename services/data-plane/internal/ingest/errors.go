// Package ingest implements the event acceptance API (ARCHITECTURE.md 16).
//
// The order of operations is fixed and deliberate: authenticate, resolve the
// project, validate, rate limit, check idempotency, then write the event and
// its outbox row in ONE transaction. Nothing reaches any queue before that
// COMMIT, so a crash between accepting and publishing costs time, never data.
package ingest

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// Stable machine-readable error codes (ARCHITECTURE.md 48, docs/API.md).
// These are part of the public contract: add codes, never rename them.
const (
	CodeInvalidRequest       = "invalid_request"
	CodeUnauthenticated      = "unauthenticated"
	CodeForbidden            = "forbidden"
	CodeNotFound             = "not_found"
	CodeConflict             = "conflict"
	CodeIdempotencyKeyReused = "idempotency_key_reused"
	CodePayloadTooLarge      = "payload_too_large"
	CodeRateLimited          = "rate_limited"
	CodeInternalError        = "internal_error"
)

// apiError is the only failure shape the ingest API emits. Carrying the status
// alongside the code keeps the mapping in one place rather than at every
// return site.
type apiError struct {
	Status  int
	Code    string
	Message string
	// Details is an optional machine-readable object. It is the only place a
	// client is given a NUMBER to act on rather than prose to parse, so the
	// keys are contract: today the sole key is retry_after_seconds, which the
	// dashboard reads off a 429.
	Details map[string]any
	// Headers are set on the response alongside the body. Retry-After has to
	// be a header as well as a body field: an HTTP client library backs off on
	// the header without knowing anything about our error envelope.
	Headers map[string]string
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func errInvalidRequest(msg string) *apiError {
	return &apiError{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: msg}
}

func errUnauthenticated(msg string) *apiError {
	return &apiError{Status: http.StatusUnauthorized, Code: CodeUnauthenticated, Message: msg}
}

func errForbidden(msg string) *apiError {
	return &apiError{Status: http.StatusForbidden, Code: CodeForbidden, Message: msg}
}

func errNotFound(msg string) *apiError {
	return &apiError{Status: http.StatusNotFound, Code: CodeNotFound, Message: msg}
}

func errConflict(msg string) *apiError {
	return &apiError{Status: http.StatusConflict, Code: CodeConflict, Message: msg}
}

func errIdempotencyKeyReused() *apiError {
	return &apiError{
		Status:  http.StatusConflict,
		Code:    CodeIdempotencyKeyReused,
		Message: "This idempotency key was used with a different request body",
	}
}

func errPayloadTooLarge(msg string) *apiError {
	return &apiError{Status: http.StatusRequestEntityTooLarge, Code: CodePayloadTooLarge, Message: msg}
}

// errRateLimited builds the 429 contract the clients already expect: the
// `rate_limited` code, a `Retry-After` header in whole seconds, and the same
// number as `details.retry_after_seconds`. The control plane's own throttle
// sets both; a data plane that set neither would make the dashboard special
// case which service refused it.
//
// The retry hint is rounded UP and floored at one second. Rounding down, or
// advertising zero, invites an immediate retry - which is the single behaviour
// a rate limit exists to stop.
func errRateLimited(retryAfter time.Duration) *apiError {
	seconds := int64(1)
	if retryAfter > time.Second {
		seconds = int64((retryAfter + time.Second - 1) / time.Second)
	}
	return &apiError{
		Status:  http.StatusTooManyRequests,
		Code:    CodeRateLimited,
		Message: "Rate limit exceeded",
		Details: map[string]any{"retry_after_seconds": seconds},
		Headers: map[string]string{"Retry-After": strconv.FormatInt(seconds, 10)},
	}
}

func errInternal() *apiError {
	return &apiError{
		Status:  http.StatusInternalServerError,
		Code:    CodeInternalError,
		Message: "An unexpected error occurred",
	}
}

// ErrorBody is the wire shape of every non-2xx response.
type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

type ErrorDetail struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"request_id"`
	Details   map[string]any `json:"details,omitempty"`
}

// AcceptedBody is the 202 response. `accepted` means durably persisted, not
// delivered (docs/API.md).
type AcceptedBody struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func writeJSON(w http.ResponseWriter, status int, body any, log *slog.Logger) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil && log != nil {
		// The status line is already on the wire; there is nothing to do but
		// record it. Never log the body: it may contain customer payload.
		log.Warn("write response body", "error", err.Error())
	}
}

func writeError(w http.ResponseWriter, requestID string, e *apiError, log *slog.Logger) {
	// Headers must be set before WriteHeader; writeJSON writes the status line.
	for name, value := range e.Headers {
		w.Header().Set(name, value)
	}
	writeJSON(w, e.Status, ErrorBody{Error: ErrorDetail{
		Code:      e.Code,
		Message:   e.Message,
		RequestID: requestID,
		Details:   e.Details,
	}}, log)
}
