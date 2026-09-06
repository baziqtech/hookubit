// Package logging provides the structured JSON logger used by every data-plane
// component (ARCHITECTURE.md 45).
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// Redacted replaces any value that must never reach a log line
// (engineering rule 12).
const Redacted = "[redacted]"

var sensitiveKeys = map[string]struct{}{
	"authorization": {}, "cookie": {}, "secret": {}, "password": {},
	"api_key": {}, "signing_secret": {}, "encryption_key": {}, "token": {},
	"webhook-signature": {},
}

// New returns a JSON logger. Sensitive attribute values are replaced rather
// than dropped, so their presence is still visible while the value is not.
func New(level string, service string) *slog.Logger {
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLevel(level),
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if _, sensitive := sensitiveKeys[strings.ToLower(a.Key)]; sensitive {
				return slog.String(a.Key, Redacted)
			}
			return a
		},
	})
	return slog.New(handler).With(slog.String("service", service))
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "trace", "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error", "fatal":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
