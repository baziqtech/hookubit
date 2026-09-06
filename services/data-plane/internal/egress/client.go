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
	IdleConnsPerHost      int
}

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
		IdleConnsPerHost:      4,
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
	dialer := &net.Dialer{
		Timeout:   limits.ConnectTimeout,
		KeepAlive: 30 * time.Second,
		Control:   guard.controlConn,
		Resolver:  &net.Resolver{PreferGo: true},
	}

	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   limits.TLSHandshakeTimeout,
		ResponseHeaderTimeout: limits.ResponseHeaderTimeout,
		ExpectContinueTimeout: time.Second,
		MaxIdleConnsPerHost:   limits.IdleConnsPerHost,
		MaxConnsPerHost:       limits.IdleConnsPerHost * 4,
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
					return &BlockedTargetError{Target: req.URL.String(), Reason: "redirect not permitted"}
				}
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
