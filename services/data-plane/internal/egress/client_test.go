package egress

import (
	"context"
	"errors"
	"testing"
)

// Regression: Do wrapped its two structurally-permanent failures with
// fmt.Errorf, which package retry could only see as "some error" - and package
// retry retried every error. The marker interface is how the call site, which
// is the only place that knows, tells the classifier.
func TestBuildRequestFailureIsMarkedPermanent(t *testing.T) {
	guard, err := NewGuard(false, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}
	c := NewClient(guard, DefaultLimits())

	// An invalid method fails before any socket is opened, so this test does no
	// network I/O.
	_, err = c.Do(context.Background(), "BAD METHOD", "https://example.com/hook", nil, nil)
	if err == nil {
		t.Fatal("Do accepted an invalid HTTP method")
	}

	var pe *PermanentError
	if !errors.As(err, &pe) {
		t.Fatalf("error %v (%T) is not a *PermanentError", err, err)
	}
	if !pe.PermanentDeliveryError() {
		t.Fatal("PermanentError does not report itself as permanent")
	}
	if pe.Unwrap() == nil {
		t.Fatal("PermanentError discarded the cause")
	}
}
