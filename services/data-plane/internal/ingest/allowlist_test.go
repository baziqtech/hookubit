package ingest

import "testing"

func TestAllowedIPEmptyListPermitsEverything(t *testing.T) {
	// The default. A control that started closed would mean every project ever
	// created is broken until somebody fills in a form.
	if !AllowedIP(nil, "203.0.113.4") {
		t.Fatal("an empty allowlist must permit every address")
	}
	if !AllowedIP([]string{}, "2001:db8::1") {
		t.Fatal("an empty allowlist must permit every address")
	}
}

func TestAllowedIPExactAndBlock(t *testing.T) {
	list := []string{"203.0.113.4", "198.51.100.0/24", "2001:db8::/32"}

	for _, addr := range []string{"203.0.113.4", "198.51.100.7", "198.51.100.255", "2001:db8::1"} {
		if !AllowedIP(list, addr) {
			t.Fatalf("%s should be permitted", addr)
		}
	}
	for _, addr := range []string{"203.0.113.5", "198.51.101.1", "2001:db9::1"} {
		if AllowedIP(list, addr) {
			t.Fatalf("%s should be refused", addr)
		}
	}
}

func TestAllowedIPUnmapsIPv4InIPv6(t *testing.T) {
	// An operator writes 203.0.113.4. A proxy in front of us reports
	// ::ffff:203.0.113.4. Those are the same machine, and a control that
	// refused the second would fail closed for a reason nobody could see.
	if !AllowedIP([]string{"203.0.113.4"}, "::ffff:203.0.113.4") {
		t.Fatal("an IPv4-mapped IPv6 address must match its IPv4 entry")
	}
	if !AllowedIP([]string{"203.0.113.0/24"}, "::ffff:203.0.113.9") {
		t.Fatal("an IPv4-mapped IPv6 address must match an IPv4 block")
	}
}

func TestAllowedIPUnparseableEntryIsSkippedNotPermissive(t *testing.T) {
	// A list that somehow contains rubbish must not become a list that permits
	// everyone. The rubbish is ignored; the rest of the list still decides.
	list := []string{"nonsense", "203.0.113.4"}
	if !AllowedIP(list, "203.0.113.4") {
		t.Fatal("a valid entry beside a bad one must still match")
	}
	if AllowedIP(list, "203.0.113.5") {
		t.Fatal("a bad entry must not permit an address no valid entry covers")
	}
}

func TestAllowedIPUnparseableAddressIsRefused(t *testing.T) {
	// "We could not tell where this came from" is not a reason to let it
	// through a control whose whole purpose is to care where it came from.
	if AllowedIP([]string{"203.0.113.0/24"}, "not-an-address") {
		t.Fatal("an unparseable address must be refused against a non-empty list")
	}
	// ...but with no list at all there is nothing to enforce, so it is allowed
	// for the same reason every other address is.
	if !AllowedIP(nil, "not-an-address") {
		t.Fatal("an empty allowlist enforces nothing, including on junk")
	}
}

func TestAllowedIPDoesNotMatchAcrossFamilies(t *testing.T) {
	if AllowedIP([]string{"0.0.0.0/0"}, "2001:db8::1") {
		t.Fatal("an IPv4 block must not contain an IPv6 address")
	}
	if AllowedIP([]string{"::/0"}, "203.0.113.4") {
		t.Fatal("an IPv6 block must not contain an IPv4 address")
	}
}

func TestAllowedIPHonoursZeroPrefix(t *testing.T) {
	// Saying "everything" explicitly is a thing people mean, and it must behave
	// the same as saying it by omission.
	if !AllowedIP([]string{"0.0.0.0/0"}, "203.0.113.4") {
		t.Fatal("0.0.0.0/0 must permit every IPv4 address")
	}
}

func TestAllowedIPTolerantOfUnmaskedBlocks(t *testing.T) {
	// 203.0.113.9/24 is a host address with a prefix length — a very common
	// way to write a block, and netip.ParsePrefix accepts it without masking.
	// Contains() on an unmasked prefix answers false for everything, so the
	// entry would silently permit nothing at all.
	if !AllowedIP([]string{"203.0.113.9/24"}, "203.0.113.4") {
		t.Fatal("an unmasked block must still cover its network")
	}
}
