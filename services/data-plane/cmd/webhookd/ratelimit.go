package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/config"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/ratelimit"
)

// policyLimiter adapts internal/ratelimit onto the ingest seam.
//
// The adapter never returns an error, and that is the contract, not an
// oversight: internal/ratelimit resolves every fault internally - a policy
// query that fails, a Redis that is gone, a bucket store that times out - and
// degrades rather than denying. The error in ingest.RateLimiter remains for
// implementations that cannot do that.
type policyLimiter struct{ inner *ratelimit.Limiter }

func (p policyLimiter) Allow(ctx context.Context, scope ingest.Scope) (ingest.LimitDecision, error) {
	d := p.inner.AllowIngest(ctx, ratelimit.Target{
		OrganizationID: scope.OrganizationID,
		ProjectID:      scope.ProjectID,
		APIKeyID:       scope.APIKeyID,
	})
	return ingest.LimitDecision{
		Allowed:      d.Allowed,
		RetryAfter:   d.RetryAfter,
		LimitedScope: string(d.Scope),
	}, nil
}

// buildIngestLimiter assembles the ingest rate limiter and says out loud what
// it will and will not enforce. Every branch below has been a production
// incident somewhere: a limiter silently running per-replica, a limiter that
// buckets the whole internet behind one proxy address, a control that is
// configurable and inert.
func buildIngestLimiter(cfg *config.Config, pool *pgxpool.Pool, log *slog.Logger) (ingest.RateLimiter, error) {
	var scripter ratelimit.Scripter
	if cfg.RedisURL == "" {
		log.Warn("REDIS_URL is not set; rate limits are enforced PER REPLICA, not fleet-wide",
			"effect", "a project limit of N is effectively N x the number of ingest pods")
	} else {
		client, err := ratelimit.NewRedisClient(cfg.RedisURL, cfg.RedisTimeout)
		if err != nil {
			return nil, fmt.Errorf("build rate limiter redis client: %w", err)
		}
		scripter = ratelimit.NewRedisScripter(client)
	}

	limiter := ratelimit.New(ratelimit.Options{
		// Always cached. An uncached source would put one query per accepted
		// event on the same pool the limiter exists to protect.
		Source: ratelimit.NewCachingSource(
			ratelimit.NewPostgresSource(pool), cfg.RateLimitPolicyCacheTTL, nil),
		Redis: scripter,
		Default: ratelimit.Default{
			Limit:         cfg.IngestRateLimit,
			WindowSeconds: cfg.IngestRateLimitWindowSeconds,
			Burst:         cfg.IngestRateLimitBurst,
		},
		Timeout: cfg.RedisTimeout,
		Logger:  log,
	})

	log.Info("ingest rate limiting enabled",
		"policy_cache_ttl_ms", cfg.RateLimitPolicyCacheTTL.Milliseconds(),
		"default_limit_per_key", cfg.IngestRateLimit,
		"default_window_seconds", cfg.IngestRateLimitWindowSeconds,
		"fleet_wide", scripter != nil,
	)
	return policyLimiter{inner: limiter}, nil
}

// buildSourceLimiter builds the pre-auth ceiling and warns about the one way it
// is routinely mis-deployed.
func buildSourceLimiter(cfg *config.Config, log *slog.Logger) *ingest.SourceLimiter {
	if cfg.IngestSourceRateLimit <= 0 {
		log.Warn("INGEST_SOURCE_RATE_LIMIT is disabled; nothing bounds an unauthenticated flood before the database",
			"risk", "api key lookups from any client can exhaust this pod's connection pool")
		return nil
	}
	if cfg.TrustedProxyHops == 0 {
		// Exactly the fault the control plane shipped with: behind an ingress,
		// every request carries the ingress pod's socket address, so the whole
		// platform shares one bucket and a trickle of anonymous traffic
		// throttles every real customer.
		log.Warn("INGEST_TRUSTED_PROXY_HOPS is 0; the pre-auth limit buckets by SOCKET PEER and X-Forwarded-For is ignored",
			"action", "set it to the exact number of proxies in front of this process if it is behind one")
	}
	log.Info("pre-auth source rate limiting enabled",
		"limit", cfg.IngestSourceRateLimit,
		"window_seconds", cfg.IngestSourceRateLimitWindowSeconds,
		"burst", cfg.IngestSourceRateLimitBurst,
		"auth_failure_penalty", cfg.IngestSourceAuthFailurePenalty,
		"trusted_proxy_hops", cfg.TrustedProxyHops,
	)
	return ingest.NewSourceLimiter(ingest.SourceLimits{
		Limit:   cfg.IngestSourceRateLimit,
		Window:  time.Duration(cfg.IngestSourceRateLimitWindowSeconds) * time.Second,
		Burst:   cfg.IngestSourceRateLimitBurst,
		Penalty: cfg.IngestSourceAuthFailurePenalty,
	}, nil)
}
