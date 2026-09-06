// Package signing implements outbound webhook signatures (ARCHITECTURE.md 28).
//
// Format:
//
//	Webhook-Signature: t=<unix-seconds>,v1=<hex hmac-sha256>
//
// The signed string is  <timestamp> "." <raw payload bytes>  — the exact bytes
// that go on the wire, never a re-serialised struct. Re-marshalling JSON before
// signing is the classic way to ship signatures consumers cannot verify.
package signing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// HeaderName is the signature header sent with every delivery.
const HeaderName = "Webhook-Signature"

// Signature is one (timestamp, secret version) signature pair.
type Signature struct {
	Timestamp time.Time
	Version   int
	Value     string
}

// Sign produces the v1 signature of payload for a single secret.
func Sign(secret string, payload []byte, ts time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts.Unix(), 10)))
	mac.Write([]byte("."))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

// ErrNoSecrets is returned by Header when an endpoint has no active secret.
// Signing fails CLOSED: a caller that ignores this error and ships the header
// anyway would deliver an unsigned payload, and Verify rejects a header with no
// v1 component, so the two halves of this package would disagree about whether
// such a delivery is valid.
var ErrNoSecrets = errors.New("signing: endpoint has no active secrets")

// Header builds the header value for one or more active secrets. During a
// rotation window an endpoint has two active secrets and receives two v1
// signatures, so a consumer that has adopted either one verifies successfully
// and can roll without downtime (ARCHITECTURE.md 28).
//
// An empty secrets slice is an error, never a header without a signature. An
// endpoint momentarily holding zero active secrets (mid-rotation, or a
// misconfigured row) must fail the delivery, not silently downgrade it.
func Header(secrets []string, payload []byte, ts time.Time) (string, error) {
	if len(secrets) == 0 {
		return "", ErrNoSecrets
	}
	parts := make([]string, 0, len(secrets)+1)
	parts = append(parts, "t="+strconv.FormatInt(ts.Unix(), 10))
	for _, s := range secrets {
		if s == "" {
			return "", fmt.Errorf("%w: an active secret is empty", ErrNoSecrets)
		}
		parts = append(parts, "v1="+Sign(s, payload, ts))
	}
	return strings.Join(parts, ","), nil
}

// Verify checks a header against a secret, rejecting signatures older than
// tolerance (ARCHITECTURE.md 29). Provided so our own tests, the "send test
// event" feature, and any consumer SDK share one implementation.
func Verify(header string, secret string, payload []byte, tolerance time.Duration, now time.Time) error {
	var (
		ts         time.Time
		haveTS     bool
		signatures []string
	)
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			secs, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return fmt.Errorf("malformed timestamp: %w", err)
			}
			ts, haveTS = time.Unix(secs, 0), true
		case "v1":
			signatures = append(signatures, value)
		}
	}
	if !haveTS {
		return fmt.Errorf("signature header has no timestamp")
	}
	if len(signatures) == 0 {
		return fmt.Errorf("signature header has no v1 signature")
	}

	age := now.Sub(ts)
	if age < 0 {
		age = -age
	}
	if age > tolerance {
		return fmt.Errorf("signature timestamp outside tolerance: age %s > %s", age, tolerance)
	}

	want := []byte(Sign(secret, payload, ts))
	for _, got := range signatures {
		if hmac.Equal([]byte(got), want) {
			return nil
		}
	}
	return fmt.Errorf("no signature matched")
}
