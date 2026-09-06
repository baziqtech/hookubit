// Package egress makes the outbound HTTP calls. It is the security-critical
// boundary of the platform: every URL it dials was supplied by a customer and
// must be assumed hostile (ARCHITECTURE.md 30, engineering rule 10).
package egress

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
)

// BlockedTargetError is returned when a destination violates egress policy.
// It is deliberately NOT retryable: a URL pointing at 169.254.169.254 will
// point there on every retry, so retrying only wastes worker capacity.
type BlockedTargetError struct {
	Target string
	Reason string
}

func (e *BlockedTargetError) Error() string {
	return fmt.Sprintf("egress blocked: %s (%s)", e.Reason, e.Target)
}

// BlockedTarget marks this error as a permanent policy rejection. Package retry
// matches on this method rather than importing egress.
func (e *BlockedTargetError) BlockedTarget() bool { return true }

// Cloud instance-metadata addresses. Reaching these from a webhook target is
// the canonical SSRF credential-theft path.
var metadataAddrs = []net.IP{
	net.ParseIP("169.254.169.254"), // AWS / GCP / Azure / DigitalOcean
	net.ParseIP("fd00:ec2::254"),   // AWS IMDSv2 over IPv6
	net.ParseIP("100.100.100.200"), // Alibaba Cloud
}

// Guard enforces destination policy. The zero value blocks all private space.
type Guard struct {
	// AllowPrivateNetworks disables the private/loopback checks entirely. Only
	// for tests and for self-hosted installs delivering to internal consumers.
	AllowPrivateNetworks bool
	// Allowlist is consulted before the private-range checks, so a self-hosted
	// operator can permit exactly one internal subnet without opening all of them.
	Allowlist []*net.IPNet
}

// NewGuard builds a Guard from configuration. cidrs are extra networks to allow.
func NewGuard(allowPrivate bool, cidrs []string) (*Guard, error) {
	g := &Guard{AllowPrivateNetworks: allowPrivate}
	for _, raw := range cidrs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		_, network, err := net.ParseCIDR(raw)
		if err != nil {
			return nil, fmt.Errorf("parse egress allowlist entry %q: %w", raw, err)
		}
		// A default route is not an allowlist; it is the absence of one, written
		// in a way that looks deliberate in a config file.
		if ones, _ := network.Mask.Size(); ones == 0 {
			return nil, fmt.Errorf("egress allowlist entry %q is a default route; list specific subnets", raw)
		}
		g.Allowlist = append(g.Allowlist, network)
	}
	return g, nil
}

// CheckURL validates the shape of a destination before any DNS lookup.
// It is a cheap first filter; CheckIP is the authoritative one, because only
// the resolved address can be trusted.
func (g *Guard) CheckURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, &BlockedTargetError{Target: raw, Reason: "malformed URL"}
	}
	switch u.Scheme {
	case "http", "https":
	default:
		return nil, &BlockedTargetError{Target: raw, Reason: "scheme " + u.Scheme + " is not permitted"}
	}
	if u.Host == "" {
		return nil, &BlockedTargetError{Target: raw, Reason: "URL has no host"}
	}
	if u.User != nil {
		return nil, &BlockedTargetError{Target: raw, Reason: "credentials in URL are not permitted"}
	}

	host := u.Hostname()
	if host == "" {
		return nil, &BlockedTargetError{Target: raw, Reason: "URL has no host"}
	}
	// A literal IP can be judged immediately. A hostname cannot be judged here
	// at all - see CheckIP, which runs at dial time on the address actually used.
	if ip := net.ParseIP(host); ip != nil {
		if err := g.CheckIP(ip); err != nil {
			return nil, err
		}
	}
	return u, nil
}

// CheckIP is the authoritative destination check. It runs against the concrete
// address the connection is about to use, which is what closes the DNS
// rebinding hole: a name that resolved publicly a moment ago cannot smuggle a
// private address past this, because this runs after resolution and before connect.
func (g *Guard) CheckIP(ip net.IP) error {
	if ip == nil {
		return &BlockedTargetError{Target: "<nil>", Reason: "no resolved address"}
	}
	target := ip.String()

	// Metadata services hold credentials, so they are refused unconditionally -
	// before the allowlist, not after it. Order matters here: an operator who
	// allowlists 169.254.0.0/16 to reach an internal link-local service must not
	// thereby open IMDS, and config.Load actively steers operators onto the
	// allowlist by refusing to boot with AllowPrivateNetworks in production.
	for _, m := range metadataAddrs {
		if m != nil && ip.Equal(m) {
			return &BlockedTargetError{Target: target, Reason: "cloud instance metadata address"}
		}
	}

	// Transition addresses embed an IPv4 destination that the network will
	// unwrap for us. Judge the address that traffic actually reaches, or a
	// NAT64 prefix becomes a clean route to anything above.
	if embedded := embeddedIPv4(ip); embedded != nil {
		if err := g.CheckIP(embedded); err != nil {
			return &BlockedTargetError{
				Target: target,
				Reason: "transition address embedding " + embedded.String(),
			}
		}
	}

	for _, allowed := range g.Allowlist {
		if allowed.Contains(ip) {
			return nil
		}
	}

	if g.AllowPrivateNetworks {
		return nil
	}

	switch {
	case ip.IsUnspecified():
		return &BlockedTargetError{Target: target, Reason: "unspecified address"}
	case ip.IsLoopback():
		return &BlockedTargetError{Target: target, Reason: "loopback address"}
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return &BlockedTargetError{Target: target, Reason: "link-local address"}
	case ip.IsInterfaceLocalMulticast(), ip.IsMulticast():
		return &BlockedTargetError{Target: target, Reason: "multicast address"}
	case ip.IsPrivate():
		return &BlockedTargetError{Target: target, Reason: "private address"}
	}

	// net.IP.IsPrivate covers RFC1918 and RFC4193 (fc00::/7) only. The ranges
	// below are also non-public and reachable inside many networks.
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127:
			return &BlockedTargetError{Target: target, Reason: "carrier-grade NAT range (100.64.0.0/10)"}
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0:
			return &BlockedTargetError{Target: target, Reason: "IETF protocol assignments (192.0.0.0/24)"}
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 2,
			v4[0] == 198 && v4[1] == 51 && v4[2] == 100,
			v4[0] == 203 && v4[1] == 0 && v4[2] == 113:
			return &BlockedTargetError{Target: target, Reason: "documentation range"}
		case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19):
			return &BlockedTargetError{Target: target, Reason: "benchmarking range (198.18.0.0/15)"}
		case v4[0] >= 240:
			return &BlockedTargetError{Target: target, Reason: "reserved range (240.0.0.0/4)"}
		}
	} else {
		// IPv4-mapped IPv6 (::ffff:127.0.0.1) is re-checked as IPv4 by To4()
		// above; what remains are IPv6-only special ranges.
		if len(ip) == net.IPv6len {
			switch {
			case ip[0] == 0x01 && ip[1] == 0x00 && ip[2] == 0 && ip[3] == 0 &&
				ip[4] == 0 && ip[5] == 0 && ip[6] == 0 && ip[7] == 0:
				return &BlockedTargetError{Target: target, Reason: "IPv6 discard prefix (100::/64)"}
			case ip[0] == 0x20 && ip[1] == 0x01 && ip[2] <= 0x01:
				return &BlockedTargetError{Target: target, Reason: "IPv6 special-purpose range (2001::/23)"}
			case ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x0d && ip[3] == 0xb8:
				return &BlockedTargetError{Target: target, Reason: "IPv6 documentation range (2001:db8::/32)"}
			}
		}
	}

	return nil
}

// controlConn is installed as net.Dialer.Control. The runtime calls it once per
// resolved address, after resolution and immediately before connect, which is
// exactly the point at which a rebinding attack would otherwise win.
func (g *Guard) controlConn(network, address string, _ syscall.RawConn) error {
	switch network {
	case "tcp", "tcp4", "tcp6":
	default:
		return &BlockedTargetError{Target: network, Reason: "network " + network + " is not permitted"}
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return &BlockedTargetError{Target: address, Reason: "unparseable dial address"}
	}
	return g.CheckIP(net.ParseIP(host))
}

// embeddedIPv4 extracts the IPv4 destination carried inside an IPv6 transition
// address, or nil if there is none. 6to4 (2002::/16) and NAT64 (64:ff9b::/96)
// both let an IPv6 literal name an IPv4 host that the network will route to -
// so http://[64:ff9b::a9fe:a9fe]/ is a request to 169.254.169.254 wearing a
// disguise. IPv4-mapped addresses are not handled here; net.IP.To4 already
// normalises those before any of the range checks run.
func embeddedIPv4(ip net.IP) net.IP {
	v6 := ip.To16()
	if v6 == nil || ip.To4() != nil {
		return nil
	}
	switch {
	case v6[0] == 0x20 && v6[1] == 0x02: // 2002::/16 - 6to4
		return net.IPv4(v6[2], v6[3], v6[4], v6[5])
	case v6[0] == 0x00 && v6[1] == 0x64 && v6[2] == 0xff && v6[3] == 0x9b: // 64:ff9b::/96 - NAT64
		return net.IPv4(v6[12], v6[13], v6[14], v6[15])
	}
	return nil
}
