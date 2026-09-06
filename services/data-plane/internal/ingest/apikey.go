package ingest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// API key wire format (ARCHITECTURE.md 11):
//
//	wk_live_<random>   keys for a `live` project
//	wk_test_<random>   keys for a `test` project
//
// Only the SHA-256 hash is ever stored or logged. `key_prefix` exists so an
// operator can identify a key in the UI without the platform holding the
// secret; it is the first prefixLength characters, which cover the environment
// marker and a few random ones - never enough to reconstruct the key.
const (
	keyScheme    = "wk_"
	prefixLength = 12
	// A key shorter than this cannot be one of ours; reject before hashing so a
	// truncated header never reaches the database as a lookup.
	minKeyLength = len("wk_live_") + 16
)

var (
	// ErrMissingCredential means no usable Authorization header was present.
	ErrMissingCredential = errors.New("missing bearer credential")
	// ErrMalformedKey means the credential was present but is not key-shaped.
	// It is deliberately indistinguishable from "unknown key" to the caller.
	ErrMalformedKey = errors.New("malformed api key")
)

// ParseBearer extracts the credential from an Authorization header.
//
// The raw header value is never returned in an error, logged, or echoed: a
// malformed credential is still a credential.
func ParseBearer(header string) (string, error) {
	if header == "" {
		return "", ErrMissingCredential
	}
	scheme, credential, found := strings.Cut(header, " ")
	if !found {
		return "", ErrMissingCredential
	}
	if !strings.EqualFold(strings.TrimSpace(scheme), "bearer") {
		return "", ErrMissingCredential
	}
	credential = strings.TrimSpace(credential)
	if credential == "" {
		return "", ErrMissingCredential
	}
	return credential, nil
}

// ValidateKeyShape rejects credentials that cannot be platform API keys.
func ValidateKeyShape(key string) error {
	if len(key) < minKeyLength || !strings.HasPrefix(key, keyScheme) {
		return ErrMalformedKey
	}
	rest := strings.TrimPrefix(key, keyScheme)
	env, secret, found := strings.Cut(rest, "_")
	if !found || secret == "" {
		return ErrMalformedKey
	}
	if env != "live" && env != "test" {
		return ErrMalformedKey
	}
	return nil
}

// KeyEnvironment reports the environment a well-formed key claims. Callers must
// still compare it against the project's environment: the claim is attacker
// controlled, the api_keys row is not.
func KeyEnvironment(key string) string {
	rest := strings.TrimPrefix(key, keyScheme)
	env, _, found := strings.Cut(rest, "_")
	if !found {
		return ""
	}
	return env
}

// HashKey returns the lowercase hex SHA-256 of the full plaintext key. This is
// exactly what the control plane stores in api_keys.key_hash, so the lookup is
// a single indexed equality on a value that is useless if the table leaks.
func HashKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// KeyPrefix returns the safe-to-display leading fragment of a key.
func KeyPrefix(key string) string {
	if len(key) <= prefixLength {
		return key
	}
	return key[:prefixLength]
}
