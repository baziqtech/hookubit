package signing

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSignIsStableAndSecretDependent(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)
	payload := []byte(`{"event_type":"order.created"}`)

	a := Sign("secret-a", payload, ts)
	if a != Sign("secret-a", payload, ts) {
		t.Fatal("signing is not deterministic")
	}
	if a == Sign("secret-b", payload, ts) {
		t.Fatal("different secrets produced the same signature")
	}
	if a == Sign("secret-a", payload, ts.Add(time.Second)) {
		t.Fatal("timestamp is not covered by the signature")
	}
}

func TestSignCoversExactBytes(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)
	// Semantically identical JSON, different bytes: must not share a signature.
	compact := []byte(`{"a":1,"b":2}`)
	spaced := []byte(`{"a": 1, "b": 2}`)
	if Sign("s", compact, ts) == Sign("s", spaced, ts) {
		t.Fatal("signature did not depend on the exact payload bytes")
	}
}

func TestHeaderCarriesOneSignaturePerActiveSecret(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)
	h, err := Header([]string{"old", "new"}, []byte("{}"), ts)
	if err != nil {
		t.Fatalf("Header: %v", err)
	}
	if n := strings.Count(h, "v1="); n != 2 {
		t.Fatalf("got %d v1 signatures, want 2", n)
	}
	if !strings.HasPrefix(h, "t=1700000000,") {
		t.Fatalf("header missing leading timestamp: %s", h)
	}
}

// The rotation guarantee: during the overlap window a consumer holding EITHER
// the old or the new secret verifies successfully.
func TestRotationOverlapAcceptsBothSecrets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	payload := []byte(`{"id":"evt_1"}`)
	h, err := Header([]string{"old-secret", "new-secret"}, payload, now)
	if err != nil {
		t.Fatalf("Header: %v", err)
	}

	for _, secret := range []string{"old-secret", "new-secret"} {
		if err := Verify(h, secret, payload, 5*time.Minute, now); err != nil {
			t.Fatalf("verify with %s: %v", secret, err)
		}
	}
	if err := Verify(h, "unrelated-secret", payload, 5*time.Minute, now); err == nil {
		t.Fatal("verification succeeded with an unrelated secret")
	}
}

func TestVerifyRejectsStaleAndTamperedRequests(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	payload := []byte(`{"amount":100}`)
	h, err := Header([]string{"s"}, payload, now)
	if err != nil {
		t.Fatalf("Header: %v", err)
	}

	if err := Verify(h, "s", payload, 5*time.Minute, now.Add(10*time.Minute)); err == nil {
		t.Fatal("replayed request outside tolerance was accepted")
	}
	if err := Verify(h, "s", []byte(`{"amount":999}`), 5*time.Minute, now); err == nil {
		t.Fatal("tampered payload was accepted")
	}
	if err := Verify("t=1700000000", "s", payload, 5*time.Minute, now); err == nil {
		t.Fatal("header without a signature was accepted")
	}
	if err := Verify("v1=abc", "s", payload, 5*time.Minute, now); err == nil {
		t.Fatal("header without a timestamp was accepted")
	}
}

// Regression: Header used to fail OPEN. With no active secrets it returned
// "t=<ts>" - a well-formed header carrying no signature at all - so a payload
// could go out unsigned while Verify, correctly, rejected the result. The two
// halves of the package must agree: no secret means no delivery.
func TestHeaderFailsClosedWithoutSecrets(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)

	for _, secrets := range [][]string{nil, {}, {""}, {"good", ""}} {
		h, err := Header(secrets, []byte("{}"), ts)
		if err == nil {
			t.Fatalf("Header(%q) returned %q with no error; an unsigned delivery is never acceptable", secrets, h)
		}
		if !errors.Is(err, ErrNoSecrets) {
			t.Fatalf("Header(%q) error = %v, want ErrNoSecrets", secrets, err)
		}
		if h != "" {
			t.Fatalf("Header(%q) returned a usable header %q alongside its error", secrets, h)
		}
	}
}

// The symmetry the bug broke: anything Header refuses to build, Verify refuses
// to accept.
func TestVerifyRejectsWhatHeaderRefusesToBuild(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	unsigned := "t=" + strconv.FormatInt(now.Unix(), 10)
	if err := Verify(unsigned, "s", []byte("{}"), 5*time.Minute, now); err == nil {
		t.Fatal("Verify accepted a header with no v1 signature")
	}
}
