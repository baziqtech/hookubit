package ratelimit

import (
	"context"
	"os"
	"testing"
	"time"
)

// requireRedis gates the only tests that can exercise the Lua script itself.
//
// Everything else in this package runs against fakeRedis, which reimplements
// Take in Go. That covers the wiring - keys, arguments, TTLs, fail-open,
// degradation - but it CANNOT catch a bug in the Lua text, a Redis version
// without redis.replicate_commands, or a reply shape the Go decoder rejects.
// This is the only place those are checked, so run it before trusting a
// deployment:
//
//	REDIS_TEST_URL=redis://localhost:6379/9 go test ./internal/ratelimit/
func requireRedis(t *testing.T) *RedisScripter {
	t.Helper()
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL is not set; skipping the live Redis token-bucket test")
	}
	client, err := NewRedisClient(url, 2*time.Second)
	if err != nil {
		t.Fatalf("build redis client: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("REDIS_TEST_URL is set but unreachable: %v", err)
	}
	return NewRedisScripter(client)
}

func TestLiveRedisTokenBucket(t *testing.T) {
	s := requireRedis(t)
	ctx := context.Background()
	key := "rl:test:" + time.Now().Format("150405.000000000")

	// 5 tokens, refilling at 5/s. The whole burst is allowed.
	for i := 0; i < 5; i++ {
		ok, _, err := s.Take(ctx, key, 5, 5, 1, time.Minute)
		if err != nil {
			t.Fatalf("Take: %v", err)
		}
		if !ok {
			t.Fatalf("request %d of the burst was refused", i+1)
		}
	}

	ok, wait, err := s.Take(ctx, key, 5, 5, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("the 6th request was allowed; the Lua bucket is not enforcing the capacity")
	}
	if wait <= 0 || wait > time.Second {
		t.Fatalf("wait = %s, want ~200ms (one token at 5/s)", wait)
	}

	// The script's clock is the SERVER's, so a real wall-clock pause really
	// does refill it.
	time.Sleep(400 * time.Millisecond)
	if ok, _, err := s.Take(ctx, key, 5, 5, 1, time.Minute); err != nil || !ok {
		t.Fatalf("the bucket did not refill over real time (ok=%v err=%v)", ok, err)
	}
}

// The bucket must be FLEET-WIDE: two independent clients charging the same key
// share one budget. This is the entire reason the limiter uses Redis rather
// than the in-process bucket it falls back to.
func TestLiveRedisBucketIsSharedAcrossClients(t *testing.T) {
	first := requireRedis(t)
	second := requireRedis(t)
	ctx := context.Background()
	key := "rl:test:shared:" + time.Now().Format("150405.000000000")

	if ok, _, err := first.Take(ctx, key, 2, 2, 1, time.Minute); err != nil || !ok {
		t.Fatalf("first client refused (ok=%v err=%v)", ok, err)
	}
	if ok, _, err := second.Take(ctx, key, 2, 2, 1, time.Minute); err != nil || !ok {
		t.Fatalf("second client refused (ok=%v err=%v)", ok, err)
	}
	ok, _, err := second.Take(ctx, key, 2, 2, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("two clients each got the full budget; the bucket is not shared")
	}
}

// The Go and Lua implementations must agree. If they drift, the limiter behaves
// differently in a Redis outage than it does normally - which is precisely when
// nobody is looking closely.
func TestLiveRedisAgreesWithTheGoReference(t *testing.T) {
	s := requireRedis(t)
	ctx := context.Background()
	key := "rl:test:parity:" + time.Now().Format("150405.000000000")

	local := NewLocal(time.Now, 0)
	localKey := key

	for i := 0; i < 12; i++ {
		gotRedis, _, err := s.Take(ctx, key, 8, 1000, 1, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		gotLocal, _ := local.Allow(localKey, 8, 1000, 1)
		if gotRedis != gotLocal {
			t.Fatalf("request %d: redis allowed=%v, go reference allowed=%v", i+1, gotRedis, gotLocal)
		}
	}
}
