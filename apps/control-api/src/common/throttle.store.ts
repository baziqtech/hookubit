import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const THROTTLE_STORE = Symbol('THROTTLE_STORE');

export interface ThrottleHit {
  /** Requests recorded in the current window, including this one. */
  count: number;
  /** Epoch ms at which the window rolls over. */
  resetAt: number;
}

export interface ThrottleStore {
  hit(key: string, windowMs: number): Promise<ThrottleHit>;
  reset(key: string): Promise<void>;
}

/**
 * Fixed-window counter, in process memory.
 *
 * Deliberately the simplest thing that closes the hole: before this, login and
 * forgot-password had NO limit at all and were open to unbounded credential
 * stuffing. A fixed window admits up to 2x the limit across a window boundary;
 * that is an acceptable trade against a brute-force attempt, and a sliding
 * window can replace it behind this interface without touching a caller.
 *
 * LIMITATION, stated rather than discovered in production: the counter is
 * per-instance, so N control-plane replicas behind a load balancer allow N x
 * limit. That is why `RedisThrottleStore` below exists and is selected whenever
 * REDIS_URL is set - the manifests run two replicas. This implementation
 * remains the local-development store and the degraded fallback when Redis is
 * unreachable.
 */
@Injectable()
export class InMemoryThrottleStore implements ThrottleStore {
  private readonly windows = new Map<string, ThrottleHit>();
  /** Sweep occasionally rather than on a timer, so nothing holds the loop open. */
  private sweepCountdown = 1000;

  async hit(key: string, windowMs: number): Promise<ThrottleHit> {
    const now = Date.now();
    this.maybeSweep(now);

    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      const fresh: ThrottleHit = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return { ...fresh };
    }

    current.count += 1;
    return { ...current };
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  private maybeSweep(now: number): void {
    this.sweepCountdown -= 1;
    if (this.sweepCountdown > 0) return;
    this.sweepCountdown = 1000;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * The minimum of ioredis this store uses. Narrow on purpose: it keeps the unit
 * tests honest (a fake implements three methods, not a Redis) and it documents
 * exactly what a replacement client has to provide.
 */
export interface ThrottleRedis {
  incr(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit?(): Promise<unknown>;
  /** Closes without waiting for in-flight replies; preferred on shutdown. */
  disconnect?(): void;
}

/** Keyspace prefix, so the throttle keys are obvious in `redis-cli --scan`. */
const KEY_PREFIX = 'throttle:';

/**
 * Shared fixed-window counter (FIX 1c).
 *
 * The in-memory store counts per process, and the Kubernetes manifests run
 * `replicas: 2`, so the effective limit was 2x the configured one and drifted
 * with every scale event - the login limit was whatever the autoscaler decided
 * that afternoon. Counting in Redis makes the limit a property of the platform
 * rather than of the pod that happened to receive the request.
 *
 * Redis here is a coordination store, not durable state: losing it loses
 * counters, which costs an attacker one window and costs users nothing. That is
 * the same guarantee the rest of the platform gives Redis, so no new promise is
 * being made.
 *
 * INCR then PTTL then (only if unset) PEXPIRE, rather than a Lua script: two
 * racing hits can both set the expiry, which extends a window by at most the
 * time between their two round trips. Re-deriving the TTL on every hit is the
 * point - a key that lost its expiry (a crash between INCR and PEXPIRE, an
 * operator FLUSH, a failover mid-window) repairs itself on the next request
 * instead of counting up forever and locking an address out permanently.
 *
 * Every Redis failure falls back to the in-memory counter for that hit and is
 * logged. Failing OPEN would hand an attacker unlimited login attempts by
 * knocking Redis over; failing CLOSED would turn a Redis blip into a total
 * authentication outage. The local counter is a real, if per-pod, limit.
 */
@Injectable()
export class RedisThrottleStore implements ThrottleStore, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottleStore.name);
  private readonly fallback = new InMemoryThrottleStore();
  private degradedSince: number | null = null;

  constructor(private readonly redis: ThrottleRedis) {}

  async hit(key: string, windowMs: number): Promise<ThrottleHit> {
    const namespaced = `${KEY_PREFIX}${key}`;
    try {
      const count = await this.redis.incr(namespaced);
      let ttl = await this.redis.pttl(namespaced);
      if (ttl < 0) {
        await this.redis.pexpire(namespaced, windowMs);
        ttl = windowMs;
      }
      this.recovered();
      return { count, resetAt: Date.now() + ttl };
    } catch (err) {
      this.degraded(err);
      return this.fallback.hit(key, windowMs);
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`${KEY_PREFIX}${key}`);
    } catch (err) {
      this.degraded(err);
    }
    await this.fallback.reset(key);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      // `disconnect` first: QUIT on a lazily-connected client that has never
      // dialled would open a connection purely in order to close it, and can
      // leave the socket pending. A rate-limit counter has nothing to flush.
      if (this.redis.disconnect) {
        this.redis.disconnect();
        return;
      }
      await this.redis.quit?.();
    } catch {
      // Shutting down; a refused close is not worth failing the shutdown over.
    }
  }

  /** Logged once per outage, not once per request, so a blip cannot flood logs. */
  private degraded(err: unknown): void {
    if (this.degradedSince !== null) return;
    this.degradedSince = Date.now();
    this.logger.error(
      `Redis rate-limit store unavailable; counting per-process until it returns. ` +
        `Limits are now per-replica. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private recovered(): void {
    if (this.degradedSince === null) return;
    const seconds = Math.round((Date.now() - this.degradedSince) / 1000);
    this.degradedSince = null;
    this.logger.warn(`Redis rate-limit store recovered after ~${seconds}s of per-process counting.`);
  }
}

/**
 * Picks the store for this deployment. Redis whenever REDIS_URL is set;
 * otherwise the per-process counter, announced LOUDLY - running more than one
 * replica on it silently multiplies every limit, which is precisely the class of
 * bug that is invisible until someone brute-forces a password.
 */
export function createThrottleStore(
  redisUrl: string | undefined,
  logger: Logger = new Logger('ThrottleStore'),
): ThrottleStore {
  if (!redisUrl) {
    logger.warn(
      'REDIS_URL is not set: rate limiting counts PER PROCESS. With more than one ' +
        'control-api replica the effective limit is (replicas x limit). Set REDIS_URL ' +
        'before scaling past a single instance.',
    );
    return new InMemoryThrottleStore();
  }

  const client = new Redis(redisUrl, {
    // Connect on first use, so a cold Redis cannot stop the control plane from
    // booting; the store degrades to in-memory until it answers.
    lazyConnect: true,
    // A rate-limit check must never become the slowest thing in a login.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  // ioredis emits `error` on a bare EventEmitter; with no listener Node turns
  // that into an uncaught exception and the process dies because Redis blinked.
  client.on('error', () => undefined);

  logger.log('Rate limiting is backed by Redis; limits are shared across replicas.');
  return new RedisThrottleStore(client as unknown as ThrottleRedis);
}
