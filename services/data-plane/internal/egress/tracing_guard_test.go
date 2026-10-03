package egress

import (
	"go/parser"
	"go/token"
	"net"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

// TestEgressIsNotInstrumentedAtTheTransport is a STRUCTURAL guard on the SSRF
// guarantee, and it is here rather than in the tracing package because this is
// the package whose transport must not move.
//
// The guarantee: Dialer.Control runs per RESOLVED ADDRESS, after resolution,
// immediately before connect, with no cached verdict (ARCHITECTURE.md 30). It
// lives on the *net.Dialer inside boundedDialer, which is reached only through
// http.Transport.DialContext.
//
// The obvious way to add tracing to an HTTP client is
// otelhttp.NewTransport(base) - which WRAPS the transport, and whose whole
// purpose is to be a RoundTripper in front of it. That composition happens to
// be safe today, but the failure mode if somebody instead builds a fresh
// transport inside a wrapper, or reaches for a client library that builds its
// own, is silent: every SSRF test in this repository keeps passing, because
// they exercise egress.Client directly, while the live worker dials
// 169.254.169.254 for anybody who asks.
//
// So the delivery path is instrumented with a MANUAL span around
// Client.Do (see internal/worker/deliver.go) and this package imports no
// telemetry at all. If a future change genuinely needs it, this test failing is
// the prompt to prove the dial control still runs - not to delete the test.
func TestEgressIsNotInstrumentedAtTheTransport(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, spec := range file.Imports {
			path := strings.Trim(spec.Path.Value, `"`)
			if strings.Contains(path, "opentelemetry") || strings.Contains(path, "otelhttp") {
				t.Fatalf("%s imports %s: the egress transport carries the SSRF guarantee "+
					"(Dialer.Control, per resolved address, immediately before connect) and "+
					"must not be wrapped or rebuilt by instrumentation. Instrument the CALL "+
					"in internal/worker instead", name, path)
			}
		}
	}
}

// TestTheTransportStillDialsThroughTheBoundedDialer pins the wiring the guard
// above protects: the client's RoundTripper is the *http.Transport this package
// built, and its DialContext is boundedDialer's - not something layered over
// it.
//
// internal/failure/outage/dns_test.go asserts the BEHAVIOUR from the outside.
// This asserts the structure, because the behavioural test would still pass
// against a transport that had been wrapped in a way that bypassed the dialer
// for a subset of requests.
func TestTheTransportStillDialsThroughTheBoundedDialer(t *testing.T) {
	guard, err := NewGuard(false, nil)
	if err != nil {
		t.Fatalf("guard: %v", err)
	}
	c := NewClient(guard, DefaultLimits())

	transport, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("the egress client's RoundTripper is %T, not *http.Transport: something "+
			"has wrapped the transport, and the SSRF dial control lives inside it",
			c.http.Transport)
	}
	if transport.DialContext == nil {
		t.Fatal("the transport has no DialContext; net/http would fall back to its own " +
			"dialer, which has no Control function and therefore no SSRF check")
	}

	want := reflect.ValueOf((&boundedDialer{}).DialContext).Type()
	if got := reflect.ValueOf(transport.DialContext).Type(); got != want {
		t.Fatalf("DialContext is %s, want %s", got, want)
	}

	// And it genuinely refuses. A structural check that did not also prove the
	// verdict is reachable would pass against a dialer whose Control was nil.
	_, err = transport.DialContext(t.Context(), "tcp", net.JoinHostPort("169.254.169.254", "80"))
	if err == nil {
		t.Fatal("the transport dialled the cloud metadata endpoint")
	}
}
