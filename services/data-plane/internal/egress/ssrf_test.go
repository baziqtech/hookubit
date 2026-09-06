package egress

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestGuard(t *testing.T) *Guard {
	t.Helper()
	g, err := NewGuard(false, nil)
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}
	return g
}

func TestCheckURLRejectsUnsupportedSchemesAndShapes(t *testing.T) {
	g := newTestGuard(t)
	cases := []string{
		"file:///etc/passwd",
		"gopher://evil.example/",
		"ftp://evil.example/",
		"redis://localhost:6379",
		"://nonsense",
		"https://",
		"https://user:pass@example.com/hook",
	}
	for _, raw := range cases {
		if _, err := g.CheckURL(raw); err == nil {
			t.Errorf("CheckURL(%q) allowed, want blocked", raw)
		}
	}
	if _, err := g.CheckURL("https://example.com/hooks/inbound"); err != nil {
		t.Errorf("CheckURL of a public https URL was blocked: %v", err)
	}
}

func TestCheckIPBlocksPrivateSpace(t *testing.T) {
	g := newTestGuard(t)
	blocked := []string{
		"127.0.0.1", "127.1.2.3", "0.0.0.0",
		"10.0.0.5", "172.16.4.4", "172.31.255.254", "192.168.1.10",
		"169.254.1.1",
		"169.254.169.254",  // AWS/GCP/Azure metadata
		"100.100.100.200",  // Alibaba metadata
		"100.64.0.1",       // CGNAT
		"192.0.2.5",        // documentation
		"198.18.0.1",       // benchmarking
		"240.0.0.1",        // reserved
		"224.0.0.1",        // multicast
		"::1",              // IPv6 loopback
		"::",               // IPv6 unspecified
		"fe80::1",          // IPv6 link-local
		"fc00::1",          // IPv6 ULA
		"fd00::1",          // IPv6 ULA
		"fd00:ec2::254",    // AWS IMDS over IPv6
		"ff02::1",          // IPv6 multicast
		"::ffff:127.0.0.1", // IPv4-mapped loopback
		"::ffff:10.0.0.1",  // IPv4-mapped RFC1918
	}
	for _, raw := range blocked {
		ip := net.ParseIP(raw)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", raw)
		}
		if err := g.CheckIP(ip); err == nil {
			t.Errorf("CheckIP(%s) allowed, want blocked", raw)
		}
	}

	allowed := []string{"1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"}
	for _, raw := range allowed {
		if err := g.CheckIP(net.ParseIP(raw)); err != nil {
			t.Errorf("CheckIP(%s) blocked, want allowed: %v", raw, err)
		}
	}
}

func TestMetadataIsBlockedEvenWhenPrivateNetworksAreAllowed(t *testing.T) {
	// Self-hosted installs may need to reach 10.0.0.0/8. They must still never
	// be able to reach the instance metadata service.
	g, err := NewGuard(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := g.CheckIP(net.ParseIP("10.0.0.5")); err != nil {
		t.Fatalf("private address blocked despite AllowPrivateNetworks: %v", err)
	}
	for _, raw := range []string{"169.254.169.254", "100.100.100.200", "fd00:ec2::254"} {
		if err := g.CheckIP(net.ParseIP(raw)); err == nil {
			t.Errorf("metadata address %s allowed with AllowPrivateNetworks; credentials are exfiltratable", raw)
		}
	}
}

func TestAllowlistPermitsOneSubnetWithoutOpeningTheRest(t *testing.T) {
	g, err := NewGuard(false, []string{"10.20.0.0/16"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.CheckIP(net.ParseIP("10.20.5.5")); err != nil {
		t.Fatalf("allowlisted address blocked: %v", err)
	}
	if err := g.CheckIP(net.ParseIP("10.99.5.5")); err == nil {
		t.Fatal("allowlisting one subnet opened the whole RFC1918 range")
	}
	if err := g.CheckIP(net.ParseIP("127.0.0.1")); err == nil {
		t.Fatal("allowlisting one subnet opened loopback")
	}
}

func TestBlockedTargetErrorIsPermanent(t *testing.T) {
	g := newTestGuard(t)
	_, err := g.CheckURL("http://169.254.169.254/latest/meta-data/")
	if err == nil {
		t.Fatal("metadata URL allowed")
	}
	var blocked *BlockedTargetError
	if !errors.As(err, &blocked) {
		t.Fatalf("error %T is not a *BlockedTargetError; retry would treat it as transient", err)
	}
	if !blocked.BlockedTarget() {
		t.Fatal("BlockedTarget() should report true")
	}
	if strings.Contains(err.Error(), "meta-data") {
		t.Log("note: full path appears in the error; acceptable, it is customer-supplied config")
	}
}

// The important one: a hostname that resolves to a private address must be
// refused at dial time, not merely by inspecting the URL string. This is the
// DNS-rebinding defence, and it is why the check lives in Dialer.Control.
func TestHostnameResolvingToLoopbackIsRefusedAtDialTime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}

	client := NewClient(newTestGuard(t), DefaultLimits())

	// "localhost" passes any naive string check - it is not an IP literal and
	// contains no digits to pattern-match on. Only the resolved address betrays it.
	_, err = client.Do(context.Background(), http.MethodPost, "http://localhost:"+port+"/hook", nil, []byte(`{}`))
	if err == nil {
		t.Fatal("delivery to a hostname resolving to loopback succeeded; SSRF guard is not effective")
	}
	var blocked *BlockedTargetError
	if !errors.As(err, &blocked) {
		t.Fatalf("expected a *BlockedTargetError, got %T: %v", err, err)
	}
}

func TestRedirectToPrivateAddressIsNotFollowed(t *testing.T) {
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer redirector.Close()

	guard, err := NewGuard(true, nil) // allow the test server's loopback address
	if err != nil {
		t.Fatal(err)
	}
	limits := DefaultLimits()
	limits.MaxRedirects = 3 // even with redirects enabled, the target is re-validated
	client := NewClient(guard, limits)

	resp, err := client.Do(context.Background(), http.MethodGet, redirector.URL, nil, nil)
	if err == nil && resp != nil && resp.StatusCode == http.StatusOK {
		t.Fatal("followed a redirect into the metadata service")
	}
	if err == nil {
		t.Fatalf("expected redirect to be refused, got status %d", resp.StatusCode)
	}
}

func TestResponseBodyIsTruncatedToTheLimit(t *testing.T) {
	// A hostile endpoint answering with an endless body must not exhaust worker
	// memory (engineering rule 11).
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		chunk := strings.Repeat("A", 4096)
		for i := 0; i < 64; i++ {
			_, _ = w.Write([]byte(chunk))
		}
	}))
	defer server.Close()

	guard, err := NewGuard(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	limits := DefaultLimits()
	limits.MaxResponseBytes = 1024
	client := NewClient(guard, limits)

	resp, err := client.Do(context.Background(), http.MethodGet, server.URL, nil, nil)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if int64(len(resp.Body)) != limits.MaxResponseBytes {
		t.Fatalf("body length %d, want %d", len(resp.Body), limits.MaxResponseBytes)
	}
	if !resp.Truncated {
		t.Fatal("oversized response was not flagged as truncated")
	}
}

// Regression for the allowlist bypass: the metadata block must sit ABOVE the
// allowlist, not below it. config.Load refuses to boot with
// EGRESS_ALLOW_PRIVATE_NETWORKS in production and points operators at
// EGRESS_PRIVATE_ALLOWLIST instead, so this is the path operators are actively
// steered onto. If it opens IMDS, a tenant can register an endpoint at
// http://169.254.169.254/latest/meta-data/iam/security-credentials/ and read the
// IAM response straight out of delivery_attempts.response_body.
func TestAllowlistCannotOpenMetadata(t *testing.T) {
	g, err := NewGuard(false, []string{"169.254.0.0/16"})
	if err != nil {
		t.Fatalf("NewGuard: %v", err)
	}
	for _, raw := range []string{"169.254.169.254", "100.100.100.200", "fd00:ec2::254"} {
		if err := g.CheckIP(net.ParseIP(raw)); err == nil {
			t.Errorf("allowlisting a subnet opened metadata address %s; credentials are exfiltratable", raw)
		}
	}
	// The rest of the allowlisted subnet still works.
	if err := g.CheckIP(net.ParseIP("169.254.10.10")); err != nil {
		t.Errorf("allowlisted non-metadata address was blocked: %v", err)
	}
}

func TestDefaultRouteIsRefusedAsAnAllowlist(t *testing.T) {
	for _, cidr := range []string{"0.0.0.0/0", "::/0"} {
		if _, err := NewGuard(false, []string{cidr}); err == nil {
			t.Errorf("NewGuard accepted %q; that is the absence of an allowlist, not an allowlist", cidr)
		}
	}
}

// 6to4 and NAT64 literals name an IPv4 destination the network will route to.
// NAT64 in particular is routine in IPv6-only Kubernetes clusters.
func TestTransitionAddressesAreResolvedBeforeJudging(t *testing.T) {
	g := newTestGuard(t)
	blocked := map[string]string{
		"2002:7f00:1::":      "6to4 wrapping 127.0.0.1",
		"2002:a9fe:a9fe::":   "6to4 wrapping 169.254.169.254",
		"2002:0a00:0001::":   "6to4 wrapping 10.0.0.1",
		"64:ff9b::7f00:1":    "NAT64 wrapping 127.0.0.1",
		"64:ff9b::a9fe:a9fe": "NAT64 wrapping 169.254.169.254",
		"2001:db8::1":        "IPv6 documentation range",
	}
	for raw, why := range blocked {
		if err := g.CheckIP(net.ParseIP(raw)); err == nil {
			t.Errorf("CheckIP(%s) allowed — %s", raw, why)
		}
	}
	// A 6to4 address wrapping a public IPv4 is still legitimate.
	if err := g.CheckIP(net.ParseIP("2002:0101:0101::")); err != nil {
		t.Errorf("6to4 wrapping public 1.1.1.1 was blocked: %v", err)
	}
}

// Even with private networks fully open, a transition address must not become a
// route to the metadata service.
func TestTransitionAddressToMetadataBlockedWithPrivateAllowed(t *testing.T) {
	g, err := NewGuard(true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := g.CheckIP(net.ParseIP("64:ff9b::a9fe:a9fe")); err == nil {
		t.Fatal("NAT64 route to 169.254.169.254 allowed when private networks are permitted")
	}
}
