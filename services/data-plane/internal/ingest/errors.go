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

func errRateLimited() *apiError {
	return &apiError{
		Status:  http.StatusTooManyRequests,
		Code:    CodeRateLimited,
		Message: "Rate limit exceeded for this project",
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
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
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
	writeJSON(w, e.Status, ErrorBody{Error: ErrorDetail{
		Code:      e.Code,
		Message:   e.Message,
		RequestID: requestID,
	}}, log)
}
