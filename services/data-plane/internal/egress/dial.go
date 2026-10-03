package egress

import (
	"context"
	"errors"
	"net"
	"os"
	"time"
)

// maxDialAddresses bounds how many of a name's addresses one attempt will try.
//
// A hostile endpoint can publish a hundred A records, and without a cap a
// single delivery could spend maxDialAddresses x ConnectTimeout of a worker
// slot proving that none of them answer. Four covers the real dual-stack cases
// (a v6 and a v4, each with a spare) and refuses to fund the pathological one.
const maxDialAddresses = 4

// boundedDialer gives name resolution a deadline of its own.
//
// # Why this exists
//
// net.Dialer has no DNS timeout. Its single Timeout covers resolution AND the
// TCP connect, so with only ConnectTimeout set a resolver that is slow rather
// than absent consumes the whole connect budget and holds a worker slot for it.
// EGRESS_DNS_TIMEOUT_MS existed as a config value, a Limits field and a
// ConfigMap key, and was read by nothing: an operator who set it to shed slow
// lookups changed no behaviour at all. This is the code that makes it a real
// control.
//
// # What it must not break
//
// The SSRF defence is structural: there is no pre-flight validation of a
// resolved address to diverge from, because the ONLY address judgement in the
// system happens in net.Dialer.Control, which the runtime calls once per
// resolved address, after resolution and immediately before connect
// (internal/failure/outage/dns_test.go pins this). So this type resolves the
// name and then dials each address AS A LITERAL through the same *net.Dialer:
// Control still runs, still runs per address, and still judges the exact
// address the socket is about to be opened to. Nothing here inspects, filters
// or caches an address - a lookup result goes straight to the dialer, and the
// verdict comes back from Control. Deciding here which addresses look
// acceptable would be a second, weaker copy of ssrf.go's policy, and the moment
// there are two the question of which one is authoritative has a wrong answer.
type boundedDialer struct {
	dialer   *net.Dialer
	resolver *net.Resolver
	// dnsTimeout bounds resolution only. Zero disables the split entirely and
	// hands the whole address to net.Dialer, which is the pre-existing
	// behaviour: the connect budget covers resolution too.
	dnsTimeout time.Duration
	// connectTimeout bounds the connect phase across ALL of a name's
	// addresses, so trying several does not multiply the budget by the number
	// of A records a customer's zone happens to carry.
	connectTimeout time.Duration
}

// DialContext resolves (bounded by dnsTimeout) and connects (bounded, in
// total, by connectTimeout).
func (d *boundedDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if d.dnsTimeout <= 0 {
		return d.dialer.DialContext(ctx, network, address)
	}

	host, port, err := net.SplitHostPort(address)
	if err != nil {
		// Not host:port. Hand it to the dialer unchanged and let it produce the
		// error it would have produced anyway.
		return d.dialer.DialContext(ctx, network, address)
	}
	// A literal needs no resolution, so it needs no resolution deadline. It
	// still goes through the dialer, and so still through Control.
	if net.ParseIP(host) != nil {
		return d.dialer.DialContext(ctx, network, address)
	}

	addrs, err := d.lookup(ctx, network, host)
	if err != nil {
		// Deliberately unwrapped. This is a *net.DNSError - including when the
		// deadline above is what ended the lookup, in which case IsTimeout is
		// set - and package worker classifies DNS failures by that concrete
		// type. Wrapping it here reclassifies every failed lookup in the
		// platform.
		return nil, err
	}

	// Cap the list BEFORE dividing the budget, so each address we will actually
	// try gets its share rather than a share sized for addresses we will skip.
	if len(addrs) > maxDialAddresses {
		addrs = addrs[:maxDialAddresses]
	}

	// One deadline for the whole connect phase, then a SHARE of it per address.
	//
	// Sharing a single deadline across a serial loop is what net.Dialer
	// deliberately does not do. A name whose first address black-holes packets -
	// a stale A record, or a filtered IPv6 path on a dual-stack node, and
	// LookupNetIP applies RFC 6724 so a global v6 address sorts first - would
	// otherwise spend the entire budget on address #1 and dial #2 on an
	// already-expired context. The endpoint is reachable and every delivery to
	// it fails with a timeout. partialDeadline mirrors net/dial.go so address #1
	// cannot starve address #2.
	deadline := time.Time{}
	if d.connectTimeout > 0 {
		deadline = time.Now().Add(d.connectTimeout)
	}
	if caller, ok := ctx.Deadline(); ok && (deadline.IsZero() || caller.Before(deadline)) {
		deadline = caller
	}

	var firstErr, firstBlocked error
	for i, ip := range addrs {
		dialCtx := ctx
		cancel := context.CancelFunc(func() {})
		if !deadline.IsZero() {
			share, err := partialDeadline(time.Now(), deadline, len(addrs)-i)
			if err != nil {
				// Out of budget. Report what actually went wrong on the
				// addresses we did try, not the exhaustion itself.
				if firstErr == nil {
					firstErr = err
				}
				break
			}
			dialCtx, cancel = context.WithDeadline(ctx, share)
		}

		conn, err := d.dialer.DialContext(dialCtx, network, net.JoinHostPort(ip, port))
		cancel()
		if err == nil {
			return conn, nil
		}
		// A refusal from Control is a policy verdict on ONE address; the name
		// may have others that are perfectly fine, so keep going.
		var blocked *BlockedTargetError
		if firstBlocked == nil && errors.As(err, &blocked) {
			firstBlocked = err
		}
		if firstErr == nil {
			firstErr = err
		}
		// The caller gave up, or the whole connect budget is gone.
		if ctx.Err() != nil {
			break
		}
	}
	// Every address failed. If any of them was refused by policy, that is the
	// error to surface: it is permanent (package retry reads the marker
	// interface), and a name that answers with private space will answer with
	// private space on every retry. Reporting the transient failure of a
	// sibling address instead buys a 24-hour retry budget spent re-proving it.
	if firstBlocked != nil {
		return nil, firstBlocked
	}
	if firstErr != nil {
		return nil, firstErr
	}
	// No addresses and no error is not a state the resolver produces, but a nil
	// connection with a nil error would panic somewhere much less obvious.
	return nil, &net.DNSError{Err: "no addresses returned", Name: host, IsNotFound: true}
}

// lookup resolves host under its own deadline.
func (d *boundedDialer) lookup(ctx context.Context, network, host string) ([]string, error) {
	lookupNet := "ip"
	switch network {
	case "tcp4", "udp4", "ip4":
		lookupNet = "ip4"
	case "tcp6", "udp6", "ip6":
		lookupNet = "ip6"
	}

	dnsCtx, cancel := context.WithTimeout(ctx, d.dnsTimeout)
	defer cancel()

	ips, err := d.resolver.LookupNetIP(dnsCtx, lookupNet, host)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		// Unmap so an IPv4 answer is dialled and judged as IPv4. Guard.CheckIP
		// normalises 4-in-6 itself via To4(), so this changes no verdict; it
		// keeps the address in the error message readable.
		out = append(out, ip.Unmap().String())
	}
	return out, nil
}

// partialDeadline divides the remaining connect budget across the addresses
// still to try. It mirrors net.partialDeadline (net/dial.go), including the
// two-second floor: dividing a small budget evenly produces per-address
// timeouts too short to complete a handshake on any of them, so it is better to
// give the earlier addresses a usable slice and run out than to guarantee every
// address fails.
func partialDeadline(now, deadline time.Time, addrsRemaining int) (time.Time, error) {
	timeRemaining := deadline.Sub(now)
	if timeRemaining <= 0 {
		return time.Time{}, os.ErrDeadlineExceeded
	}
	timeout := timeRemaining / time.Duration(addrsRemaining)
	const saneMinimum = 2 * time.Second
	if timeout < saneMinimum {
		if timeRemaining < saneMinimum {
			timeout = timeRemaining
		} else {
			timeout = saneMinimum
		}
	}
	return now.Add(timeout), nil
}
