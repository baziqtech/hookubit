// Package ids generates the prefixed, lexicographically sortable identifiers
// used across the platform (ARCHITECTURE.md 13). The control plane produces the
// same shape in TypeScript; see apps/control-api/src/common/ids.ts.
package ids

import (
	"crypto/rand"
	"fmt"
	"strings"

	"github.com/oklog/ulid/v2"
)

// Prefixes shared with the control plane. Keep both lists in step.
const (
	Organization = "org"
	User         = "usr"
	Member       = "mem"
	Project      = "proj"
	APIKey       = "key"
	Endpoint     = "ep"
	Secret       = "eps"
	Subscription = "sub"
	RetryPolicy  = "rp"
	RateLimit    = "rl"
	Event        = "evt"
	Outbox       = "obx"
	Idempotency  = "idm"
	Delivery     = "del"
	Attempt      = "att"
	AuditLog     = "aud"
	Usage        = "usg"
	Worker       = "wrk"
)

// New returns a new prefixed ULID, e.g. "evt_01J9Z...".
func New(prefix string) string {
	return prefix + "_" + ulid.Make().String()
}

// Parse splits a prefixed identifier, reporting whether it is well formed and
// carries the expected prefix.
func Parse(id, wantPrefix string) (ulid.ULID, error) {
	prefix, raw, ok := strings.Cut(id, "_")
	if !ok {
		return ulid.ULID{}, fmt.Errorf("identifier %q has no prefix", id)
	}
	if prefix != wantPrefix {
		return ulid.ULID{}, fmt.Errorf("identifier %q has prefix %q, want %q", id, prefix, wantPrefix)
	}
	parsed, err := ulid.ParseStrict(raw)
	if err != nil {
		return ulid.ULID{}, fmt.Errorf("identifier %q is not a valid ULID: %w", id, err)
	}
	return parsed, nil
}

// Token returns n cryptographically random bytes, hex encoded. Used for API
// keys and endpoint signing secrets.
func Token(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return fmt.Sprintf("%x", buf), nil
}
