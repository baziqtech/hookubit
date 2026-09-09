package main

import (
	"context"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/ratelimit"
)

// The adapter is the seam that made this control inert: rate_limit_policies was
// fully CRUD-able while cmd/webhookd wired ingest.AllowAll{}. These assert the
// translation is lossless in the two directions that matter - a refusal stays a
// refusal, and its retry hint survives to the caller.
func TestPolicyLimiterAdapterCarriesTheRefusalAndItsRetryHint(t *testing.T) {
	limiter := ratelimit.New(ratelimit.Options{
		Default: ratelimit.Default{Limit: 1, WindowSeconds: 10},
	})
	adapter := policyLimiter{inner: limiter}
	scope := ingest.Scope{OrganizationID: "org_1", ProjectID: "prj_1", APIKeyID: "key_1"}

	first, err := adapter.Allow(context.Background(), scope)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if !first.Allowed {
		t.Fatal("the first request was refused against a limit of 1")
	}

	second, err := adapter.Allow(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	if second.Allowed {
		t.Fatal("the configured ceiling did not reach the handler; the control is still inert")
	}
	if second.RetryAfter <= 0 || second.RetryAfter > 11*time.Second {
		t.Fatalf("RetryAfter = %s, want a hint inside the 10s window", second.RetryAfter)
	}
	if second.LimitedScope != string(ratelimit.ScopeIngest) {
		t.Fatalf("LimitedScope = %q, want %q", second.LimitedScope, ratelimit.ScopeIngest)
	}
}

// The adapter must never surface an error: internal/ratelimit resolves every
// fault into a degradation, and an error here would be read by the handler as
// "fail open" - correct by accident, but for the wrong reason.
func TestPolicyLimiterAdapterNeverErrors(t *testing.T) {
	adapter := policyLimiter{inner: ratelimit.New(ratelimit.Options{
		Source:  failingSource{},
		Default: ratelimit.Default{Limit: 100, WindowSeconds: 1},
	})}
	if _, err := adapter.Allow(context.Background(), ingest.Scope{ProjectID: "prj_1", APIKeyID: "key_1"}); err != nil {
		t.Fatalf("the adapter surfaced an error instead of degrading: %v", err)
	}
}

type failingSource struct{}

func (failingSource) Policies(context.Context, string, string) ([]ratelimit.Row, error) {
	return nil, context.DeadlineExceeded
}
