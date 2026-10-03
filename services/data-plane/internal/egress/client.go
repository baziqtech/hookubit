package egress

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"time"
)

// Limits bounds every outbound request (ARCHITECTURE.md 31, engineering rule
// 29). Nothing here may be left at zero in production: an unbounded read from a
// hostile endpoint is a memory exhaustion bug waiting for a slow Friday.
type Limits struct {
	DNSTimeout            time.Duration
	ConnectTimeout        time.Duration
	TLSHandshakeTimeout   time.Duration
	ResponseHeaderTimeout time.Duration
	TotalTimeout          time.Duration
	MaxResponseBytes      int64
	MaxRedirects          int

	// MaxConnsPerHost caps how many connections this process will hold open to
	// one host:port AT ONCE, across every endpoint and every tenant resolving
	// there. It is a hard ceiling on outbound concurrency per destination:
	// net/http BLOCKS a request that would exceed it until a connection frees
	// up, so a value below the worker pool silently overrides
	// MAX_CONCURRENCY_PER_ENDPOINT and friends and turns configured policy into
	// a lie. See DefaultMaxConnsPerHost.
	MaxConnsPerHost int

	// IdleConnsPerHost bounds the WARM pool kept per host between requests. It
	// never bounds concurrency - it only decides how many finished connections
	// survive for reuse instead of being closed. Too low and every delivery to
	// a busy customer pays a fresh TCP+TLS handshake; too high and the process
	// sits on a socket per slot per host it has ever spoken to.
	IdleConnsPerHost int
}

// Per-host connection defaults, used when Limits leaves them at zero. They are
// deliberately not zero themselves: net/http reads MaxConnsPerHost == 0 as
// UNLIMITED, which is the opposite of what a zero in this struct means
// everywhere else in it.
//
// DefaultMaxConnsPerHost matches the default WORKER_CONCURRENCY. The real
// default is derived from the configured pool size (see config.Load); this
// constant is the fallback for callers that build a client without config.
const (
	DefaultMaxConnsPerHost  = 64
	DefaultIdleConnsPerHost = 16
)

// DefaultLimits are conservative starting values, overridden per endpoint.
func DefaultLimits() Limits {
	return Limits{
		DNSTimeout:            2 * time.Second,
		ConnectTimeout:        3 * time.Second,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		TotalTimeout:          30 * time.Second,
		MaxResponseBytes:      64 << 10,
		MaxRedirects:          0,
		MaxConnsPerHost:       DefaultMaxConnsPerHost,
		IdleConnsPerHost:      DefaultIdleConnsPerHost,
	}
}

// Client is a hardened HTTP client. Construct one per process and share it;
// the transport pools connections.
type Client struct {
	http   *http.Client
	guard  *Guard
	limits Limits
}

// NewClient builds an egress client whose dialer refuses blocked addresses and
// whose every phase has a deadline.
func NewClient(guard *Guard, limits Limits) *Client {
	// PreferGo is load-bearing, not a preference: it keeps resolution inside
	// the Go resolver, where a context deadline actually cancels it. cgo's
	// getaddrinfo runs on a thread this process cannot interrupt, so a
	// DNSTimeout would expire while the lookup carried on holding an OS thread.
	return newClient(guard, limits, &net.Resolver{PreferGo: true})
}

// newClient is NewClient with an injectable resolver, so a test can point
// resolution at a nameserver that never answers without needing one.
func newClient(guard *Guard, limits Limits, resolver *net.Resolver) *Client {
	dialer := &net.Dialer{
		Timeout:   limits.ConnectTimeout,
		KeepAlive: 30 * time.Second,
		Control:   guard.controlConn,
		Resolver:  resolver,
	}

	// DNSTimeout is bounded separately from the connect. Sharing one budget is
	// what let a slow resolver eat the entire connect allowance and stall the
	// worker slot behind it; see boundedDialer, which also explains why
	// resolution moving here does not move the SSRF judgement.
	bounded := &boundedDialer{
		dialer:         dialer,
		resolver:       resolver,
		dnsTimeout:     limits.DNSTimeout,
		connectTimeout: limits.ConnectTimeout,
	}

	// The per-host ceiling used to be derived - MaxConnsPerHost =
	// IdleConnsPerHost * 4, off a hard-coded 4 - so the entire data plane made
	// at most 16 concurrent requests to any one host:port however large the
	// worker pool was. A k6 run measured what that costs: same scenario, same
	// rates, endpoints on one host gave a fast-group p95 of 119.9 s against
	// 16.6 s with the same endpoints spread over eight ports. Per-endpoint
	// isolation cannot be configured underneath a ceiling that low, so the
	// ceiling is now configuration, not arithmetic.
	maxConns := limits.MaxConnsPerHost
	if maxConns <= 0 {
		maxConns = DefaultMaxConnsPerHost
	}
	idleConns := limits.IdleConnsPerHost
	if idleConns <= 0 {
		idleConns = DefaultIdleConnsPerHost
	}
	if idleConns > maxConns {
		// Idle slots above the ceiling can never be filled; clamping keeps the
		// transport's two numbers describing the same pool.
		idleConns = maxConns
	}

	transport := &http.Transport{
		DialContext:           bounded.DialContext,
		TLSHandshakeTimeout:   limits.TLSHandshakeTimeout,
		ResponseHeaderTimeout: limits.ResponseHeaderTimeout,
		ExpectContinueTimeout: time.Second,
		MaxIdleConnsPerHost:   idleConns,
		MaxConnsPerHost:       maxConns,
		IdleConnTimeout:       60 * time.Second,
		ForceAttemptHTTP2:     true,
		DisableCompression:    false,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}

	return &Client{
		http: &http.Client{
			Transport: transport,
			Timeout:   limits.TotalTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				// Every redirect destination is re-validated, and by default we
				// do not follow at all (ARCHITECTURE.md 30). A 302 to
				// http://169.254.169.254/ is the whole attack.
				if len(via) > limits.MaxRedirects {
					err := &BlockedTargetError{
						Target: req.URL.String(),
						Reason: "redirect not permitted",
						Code:   CodeRedirect,
					}
					recordBlocked(err)
					return err
				}
				// guard.CheckURL counts its own refusals.
				if _, err := guard.CheckURL(req.URL.String()); err != nil {
					return err
				}
				return nil
			},
		},
		guard:  guard,
		limits: limits,
	}
}

// Response is the bounded result of one delivery attempt.
type Response struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
	// Truncated reports that the endpoint returned more than MaxResponseBytes.
	Truncated bool
	Duration  time.Duration
}

// PermanentError marks a delivery failure that will recur identically on every
// retry. Package retry matches on the PermanentDeliveryError method rather than
// importing egress, exactly as it does for BlockedTargetError.
type PermanentError struct {
	Op  string
	Err error
}

func (e *PermanentError) Error() string { return e.Op + ": " + e.Err.Error() }

func (e *PermanentError) Unwrap() error { return e.Err }

// PermanentDeliveryError marks this failure as one no retry can fix.
func (e *PermanentError) PermanentDeliveryError() bool { return true }

// Do performs one attempt. The URL is validated before the request is built and
// again, per resolved address, at dial time.
func (c *Client) Do(ctx context.Context, method, rawURL string, headers http.Header, body []byte) (*Response, error) {
	if _, err := c.guard.CheckURL(rawURL); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, c.limits.TotalTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, method, rawURL, newBodyReader(body))
	if err != nil {
		// A request that cannot be constructed - bad method, unparseable URL -
		// cannot be constructed on the next attempt either.
		return nil, &PermanentError{Op: "build request", Err: err}
	}
	req.ContentLength = int64(len(body))
	for k, values := range headers {
		for _, v := range values {
			req.Header.Add(k, v)
		}
	}

	start := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Read at most MaxResponseBytes+1 so we can tell "exactly at the limit"
	// from "truncated".
	limited := io.LimitReader(resp.Body, c.limits.MaxResponseBytes+1)
	respBody, readErr := io.ReadAll(limited)
	if readErr != nil && readErr != io.EOF {
		// The endpoint answered; we simply failed to read its body. Retrying
		// re-POSTs a payload the endpoint has already accepted and acted on,
		// which is worse than losing the response we never needed. Permanent by
		// intent, not by transport class.
		return nil, &PermanentError{Op: "read response body", Err: readErr}
	}
	truncated := int64(len(respBody)) > c.limits.MaxResponseBytes
	if truncated {
		respBody = respBody[:c.limits.MaxResponseBytes]
	}
	// Drain the remainder so the connection can be reused, but never unbounded.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))

	return &Response{
		StatusCode: resp.StatusCode,
		Headers:    resp.Header,
		Body:       respBody,
		Truncated:  truncated,
		Duration:   time.Since(start),
	}, nil
}

func newBodyReader(body []byte) io.Reader {
	if len(body) == 0 {
		return nil
	}
	return newBytesReader(body)
}
