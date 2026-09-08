package ingest

import (
	"errors"
	"strings"
	"testing"
)

const validKey = "wk_live_0123456789abcdef0123456789abcdef"

func TestParseBearer(t *testing.T) {
	cases := []struct {
		name   string
		header string
		want   string
		err    error
	}{
		{"standard", "Bearer " + validKey, validKey, nil},
		{"lowercase scheme", "bearer " + validKey, validKey, nil},
		{"mixed case scheme", "BeArEr " + validKey, validKey, nil},
		{"padded credential", "Bearer   " + validKey + "  ", validKey, nil},
		{"empty header", "", "", ErrMissingCredential},
		{"no scheme", validKey, "", ErrMissingCredential},
		{"wrong scheme", "Basic " + validKey, "", ErrMissingCredential},
		{"scheme only", "Bearer ", "", ErrMissingCredential},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseBearer(tc.header)
			if !errors.Is(err, tc.err) {
				t.Fatalf("error = %v, want %v", err, tc.err)
			}
			if got != tc.want {
				t.Fatalf("credential = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseBearerNeverEchoesTheCredential(t *testing.T) {
	// A malformed credential is still a credential; it must not reach a log
	// line or an error string.
	secret := "Basic hunter2-this-is-a-secret"
	_, err := ParseBearer(secret)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("error message leaked the credential: %q", err)
	}
}

func TestValidateKeyShape(t *testing.T) {
	cases := []struct {
		name string
		key  string
		ok   bool
	}{
		{"live key", validKey, true},
		{"test key", "wk_test_0123456789abcdef0123456789abcdef", true},
		{"unknown environment", "wk_prod_0123456789abcdef0123456789abcdef", false},
		// Deliberately NOT a real vendor prefix. This asserts that any scheme
		// other than wk_ is rejected; using sk_ (Stripe) made the line a
		// Stripe-shaped string that GitHub push protection blocks, and a fake
		// secret that trips a scanner costs exactly as much as a real one.
		{"wrong scheme", "xx_live_0123456789abcdef0123456789abcdef", false},
		{"too short", "wk_live_abc", false},
		{"no secret part", "wk_live_", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateKeyShape(tc.key)
			if tc.ok && err != nil {
				t.Fatalf("ValidateKeyShape(%q) = %v, want nil", tc.key, err)
			}
			if !tc.ok && !errors.Is(err, ErrMalformedKey) {
				t.Fatalf("ValidateKeyShape(%q) = %v, want ErrMalformedKey", tc.key, err)
			}
		})
	}
}

func TestKeyEnvironment(t *testing.T) {
	if got := KeyEnvironment(validKey); got != "live" {
		t.Fatalf("environment = %q, want live", got)
	}
	if got := KeyEnvironment("wk_test_abcdef0123456789abcdef01234567"); got != "test" {
		t.Fatalf("environment = %q, want test", got)
	}
}

func TestHashKeyIsStableAndDoesNotContainThePlaintext(t *testing.T) {
	h1 := HashKey(validKey)
	h2 := HashKey(validKey)
	if h1 != h2 {
		t.Fatal("hash is not deterministic")
	}
	if len(h1) != 64 {
		t.Fatalf("hash length = %d, want 64 hex characters", len(h1))
	}
	if strings.Contains(h1, "0123456789abcdef0123456789abcdef") {
		t.Fatal("hash contains the plaintext key")
	}
	// Known vector, so a change of algorithm is a test failure rather than a
	// silent lockout of every existing key.
	if got := HashKey("wk_live_test"); got != "422105b1e2fb4ab01b33157131e4fcf00a0a0ca0f8e4f2fe1173e971d397d63f" {
		t.Fatalf("HashKey drifted: got %s", got)
	}
}

func TestHashKeyDistinguishesNearIdenticalKeys(t *testing.T) {
	if HashKey(validKey) == HashKey(validKey+"a") {
		t.Fatal("truncated key hashes to the same value")
	}
}

func TestKeyPrefixIsShortEnoughToBeSafe(t *testing.T) {
	prefix := KeyPrefix(validKey)
	if prefix != "wk_live_0123" {
		t.Fatalf("prefix = %q", prefix)
	}
	if len(prefix) >= len(validKey) {
		t.Fatal("prefix is the whole key")
	}
	if got := KeyPrefix("wk_live"); got != "wk_live" {
		t.Fatalf("short input mangled: %q", got)
	}
}
