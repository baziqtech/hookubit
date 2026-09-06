package retry

import (
	"crypto/x509"
	"errors"
)

// blockedTarget is satisfied by egress.BlockedTargetError. It lives here as an
// interface so package retry does not import package egress (which imports
// retry indirectly through the worker).
type blockedTarget interface {
	BlockedTarget() bool
}

// IsBlockedTarget reports whether err is an SSRF policy rejection.
func IsBlockedTarget(err error) bool {
	var bt blockedTarget
	if errors.As(err, &bt) {
		return bt.BlockedTarget()
	}
	return false
}

// permanentError mirrors the blockedTarget pattern for failures that are not
// policy rejections but are still structurally permanent: retrying them cannot
// change the outcome. egress.PermanentError satisfies it, and so may any future
// producer of delivery errors, without either side importing the other.
//
// The marker is applied at the call site that knows, not inferred here from an
// error string. String matching on transport errors is how retry classifiers
// rot: the messages are not part of any API.
type permanentError interface {
	PermanentDeliveryError() bool
}

// IsPermanentError reports whether err has been explicitly marked as one that
// will fail identically on every retry.
func IsPermanentError(err error) bool {
	var pe permanentError
	if errors.As(err, &pe) {
		return pe.PermanentDeliveryError()
	}
	return false
}

// isPermanentTLSError reports whether a TLS failure needs a human rather than a
// retry.
//
//   - UnknownAuthorityError: a self-signed or privately-issued certificate. It
//     will be exactly as untrusted in 24 hours' time.
//   - HostnameError: the certificate is not valid for the endpoint's host.
//
// x509.CertificateInvalidError is intentionally excluded. Its most common cause
// is expiry, which is precisely the failure that heals on its own when the
// endpoint's operator renews - one we want retries to survive.
func isPermanentTLSError(err error) bool {
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return true
	}
	var hostname x509.HostnameError
	if errors.As(err, &hostname) {
		return true
	}
	return false
}
