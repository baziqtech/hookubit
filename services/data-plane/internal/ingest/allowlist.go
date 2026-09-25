package ingest

import (
	"net/netip"
	"strings"
)

// AllowedIP reports whether addr may publish to a project whose allowlist is
// `allowed`.
//
// An EMPTY list permits everything. That is the default and it is deliberate:
// a control that starts closed would mean every project ever created is broken
// until somebody fills in a form, and the first thing they would do is add
// 0.0.0.0/0 and never look at it again.
//
// Entries are addresses or CIDR blocks, validated by the control plane before
// they are stored (apps/control-api/src/projects/allowed-ips.ts). An entry this
// function cannot parse is SKIPPED rather than treated as a match: a list that
// somehow contains rubbish must not turn into a list that permits everyone.
//
// IPv4-mapped IPv6 addresses are unmapped first, so an operator who writes
// `203.0.113.4` is not defeated by a proxy that reports `::ffff:203.0.113.4`.
func AllowedIP(allowed []string, addr string) bool {
	if len(allowed) == 0 {
		return true
	}

	ip, err := netip.ParseAddr(strings.TrimSpace(addr))
	if err != nil {
		// The address could not be parsed at all. With a non-empty allowlist,
		// the safe direction is to refuse: "we could not tell where this came
		// from" is not a reason to let it in through a control whose whole
		// purpose is to care where it came from.
		return false
	}
	ip = ip.Unmap()

	for _, raw := range allowed {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}

		if strings.Contains(entry, "/") {
			prefix, err := netip.ParsePrefix(entry)
			if err != nil {
				continue
			}
			if prefix.Addr().Unmap().BitLen() != ip.BitLen() {
				// Comparing across families is not a match, it is a category
				// error — and netip.Prefix.Contains would answer false anyway.
				continue
			}
			if prefix.Masked().Contains(ip) {
				return true
			}
			continue
		}

		single, err := netip.ParseAddr(entry)
		if err != nil {
			continue
		}
		if single.Unmap() == ip {
			return true
		}
	}

	return false
}
