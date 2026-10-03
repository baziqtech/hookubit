package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Scripter is the whole Redis surface the limiter needs: one atomic
// take-a-token against one key.
//
// The seam is typed rather than a generic Eval so the fake in the tests
// exercises the same call shape the production code makes - key naming,
// argument order, error propagation - instead of a stringly-typed script blob
// nothing can check. What the fake cannot exercise is the Lua itself; that is
// covered only by the live-Redis test gated on REDIS_TEST_URL.
type Scripter interface {
	// Take charges `cost` tokens against key. It returns whether the request
	// may proceed and, on a refusal, how long until it could.
	//
	// An error is a LIMITER FAULT, not a refusal. Callers must fail open.
	Take(ctx context.Context, key string, capacity, ratePerSec, cost float64, ttl time.Duration) (bool, time.Duration, error)
}

// takeScript is a transliteration of Take in bucket.go. Keep the two in step.
//
// Time comes from the Redis server (`TIME`), not from the caller. Every replica
// charging the same bucket therefore shares one clock: with a client-supplied
// timestamp a pod whose clock ran fast would credit itself a refill it had not
// earned, and the fleet-wide bucket the Redis implementation exists to provide
// would quietly stop being fleet-wide.
//
// TIME is non-deterministic, so the script must not be replicated verbatim.
// `replicate_commands()` switches this script to effects replication; on Redis
// 7 that is already the default and the call is a documented no-op.
const takeScript = `
if redis.replicate_commands then redis.replicate_commands() end
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])

local clock = redis.call('TIME')
local now   = tonumber(clock[1]) + (tonumber(clock[2]) / 1000000)

local stored = redis.call('HMGET', KEYS[1], 'n', 't')
local tokens = tonumber(stored[1])
local ts     = tonumber(stored[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts     = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
local wait_ms = 0
if tokens >= cost then
  tokens  = tokens - cost
  allowed = 1
else
  wait_ms = math.ceil(((cost - tokens) / rate) * 1000)
  if wait_ms < 1 then wait_ms = 1 end
end

redis.call('HSET', KEYS[1], 'n', tokens, 't', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, wait_ms}
`

// RedisScripter runs takeScript against a Redis server.
type RedisScripter struct {
	client redis.Scripter
	script *redis.Script
}

// NewRedisScripter wraps any go-redis client (single node, sentinel, cluster).
func NewRedisScripter(client redis.Scripter) *RedisScripter {
	return &RedisScripter{client: client, script: redis.NewScript(takeScript)}
}

// NewRedisClient builds a client from a redis:// URL with timeouts short enough
// that an unreachable Redis costs the ingest path milliseconds, not seconds.
//
// The timeouts are the point. A rate limiter is an optimisation on a path whose
// budget is already spoken for (INGEST_DB_TIMEOUT_MS); a limiter that blocks a
// request for its own default 3s dial timeout has done more damage than the
// traffic it was refusing.
func NewRedisClient(rawURL string, timeout time.Duration) (*redis.Client, error) {
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	if timeout <= 0 {
		timeout = 50 * time.Millisecond
	}
	opts.DialTimeout = timeout
	opts.ReadTimeout = timeout
	opts.WriteTimeout = timeout
	// Waiting for a pooled connection is itself a stall. Fail fast and let the
	// caller degrade to the in-process bucket.
	opts.PoolTimeout = timeout
	return redis.NewClient(opts), nil
}

func (r *RedisScripter) Take(
	ctx context.Context, key string, capacity, ratePerSec, cost float64, ttl time.Duration,
) (bool, time.Duration, error) {
	ms := ttl.Milliseconds()
	if ms < 1000 {
		ms = 1000
	}
	res, err := r.script.Run(ctx, r.client, []string{key}, capacity, ratePerSec, cost, ms).Result()
	if err != nil {
		return false, 0, fmt.Errorf("redis token bucket: %w", err)
	}
	values, ok := res.([]any)
	if !ok || len(values) != 2 {
		return false, 0, fmt.Errorf("redis token bucket: unexpected reply %T", res)
	}
	allowed, ok1 := values[0].(int64)
	waitMS, ok2 := values[1].(int64)
	if !ok1 || !ok2 {
		return false, 0, fmt.Errorf("redis token bucket: unexpected reply shape")
	}
	if allowed == 1 {
		return true, 0, nil
	}
	return false, time.Duration(waitMS) * time.Millisecond, nil
}

// ttlFor is how long an idle bucket's state is worth keeping: twice the time it
// takes to refill from empty, floored at ten seconds. Shorter and a bucket
// would forget a client that paused mid-window, handing back a free burst;
// longer and Redis holds state for callers that will never return.
func ttlFor(b Bucket) time.Duration {
	if b.RatePerSec <= 0 {
		return time.Minute
	}
	refill := time.Duration(b.Capacity / b.RatePerSec * float64(time.Second))
	ttl := 2 * refill
	if ttl < 10*time.Second {
		ttl = 10 * time.Second
	}
	if ttl > 48*time.Hour {
		ttl = 48 * time.Hour
	}
	return ttl
}
