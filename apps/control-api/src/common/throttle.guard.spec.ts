import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from './errors';
import { ThrottleStore } from './throttle.store';
import { THROTTLE_KEY, ThrottleGuard, ThrottleOptions } from './throttle.guard';
import {
  InMemoryThrottleStore,
  RedisThrottleStore,
  ThrottleRedis,
  createThrottleStore,
} from './throttle.store';

function contextFor(
  options: ThrottleOptions | undefined,
  req: { ip?: string; body?: Record<string, unknown> },
): { context: ExecutionContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const request = { ip: req.ip, body: req.body, socket: {} };
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  const handler = (): void => undefined;
  Reflect.defineMetadata(THROTTLE_KEY, options, handler);

  return {
    headers,
    context: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => handler,
      getClass: () => class Anon {},
    } as unknown as ExecutionContext,
  };
}

function guard(store: ThrottleStore = new InMemoryThrottleStore()): ThrottleGuard {
  return new ThrottleGuard(new Reflector(), store);
}

const LOGIN: ThrottleOptions = {
  name: 'auth.login',
  limit: 3,
  windowMs: 60_000,
  byBodyField: 'email',
};

describe('ThrottleGuard (FIX 8)', () => {
  it('allows a handler with no @Throttle metadata through untouched', async () => {
    const g = guard();
    for (let i = 0; i < 50; i += 1) {
      const { context } = contextFor(undefined, { ip: '1.2.3.4' });
      await expect(g.canActivate(context)).resolves.toBe(true);
    }
  });

  it('closes the open brute-force: the request past the limit is refused', async () => {
    const g = guard();
    const call = (): ReturnType<ThrottleGuard['canActivate']> =>
      g.canActivate(
        contextFor(LOGIN, { ip: '1.2.3.4', body: { email: 'ada@example.com' } }).context,
      );

    await expect(call()).resolves.toBe(true);
    await expect(call()).resolves.toBe(true);
    await expect(call()).resolves.toBe(true);
    await expect(call()).rejects.toBeInstanceOf(AppError);
    await expect(call()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('answers with Retry-After so a legitimate client can back off', async () => {
    const g = guard();
    let headers: Record<string, string> = {};
    for (let i = 0; i < 4; i += 1) {
      const built = contextFor(LOGIN, { ip: '9.9.9.9', body: { email: 'a@b.co' } });
      headers = built.headers;
      await g.canActivate(built.context).catch(() => undefined);
    }
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
    expect(Number(headers['Retry-After'])).toBeLessThanOrEqual(60);
  });

  it('limits one account sprayed from many addresses', async () => {
    const g = guard();
    const attempt = (ip: string): ReturnType<ThrottleGuard['canActivate']> =>
      g.canActivate(contextFor(LOGIN, { ip, body: { email: 'victim@example.com' } }).context);

    await expect(attempt('1.1.1.1')).resolves.toBe(true);
    await expect(attempt('2.2.2.2')).resolves.toBe(true);
    await expect(attempt('3.3.3.3')).resolves.toBe(true);
    // Fourth address, same account: the per-subject bucket is already spent.
    await expect(attempt('4.4.4.4')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('keeps buckets separate per route and per account', async () => {
    const g = guard();
    const forgot: ThrottleOptions = { ...LOGIN, name: 'auth.forgot' };

    for (let i = 0; i < 3; i += 1) {
      await g.canActivate(contextFor(LOGIN, { ip: '5.5.5.5', body: { email: 'a@x.co' } }).context);
    }
    await expect(
      g.canActivate(contextFor(LOGIN, { ip: '5.5.5.5', body: { email: 'a@x.co' } }).context),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    // A different account from a different address is unaffected...
    await expect(
      g.canActivate(contextFor(LOGIN, { ip: '6.6.6.6', body: { email: 'b@x.co' } }).context),
    ).resolves.toBe(true);
    // ...and so is a different route from the exhausted address.
    await expect(
      g.canActivate(contextFor(forgot, { ip: '5.5.5.5', body: { email: 'c@x.co' } }).context),
    ).resolves.toBe(true);
  });

  it('treats a body field case-insensitively so casing cannot evade the limit', async () => {
    const g = guard();
    const attempt = (email: string): ReturnType<ThrottleGuard['canActivate']> =>
      g.canActivate(contextFor(LOGIN, { ip: '7.7.7.7', body: { email } }).context);

    await attempt('Ada@Example.com');
    await attempt('ada@example.com');
    await attempt('ADA@EXAMPLE.COM');
    await expect(attempt('  ada@example.com ')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('still limits by address when the body carries no subject', async () => {
    const g = guard();
    const attempt = (): ReturnType<ThrottleGuard['canActivate']> =>
      g.canActivate(contextFor({ ...LOGIN, byBodyField: undefined }, { ip: '8.8.8.8' }).context);

    await attempt();
    await attempt();
    await attempt();
    await expect(attempt()).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('InMemoryThrottleStore', () => {
  it('rolls the window over once it expires', async () => {
    const store = new InMemoryThrottleStore();
    const first = await store.hit('k', 20);
    expect(first.count).toBe(1);
    expect((await store.hit('k', 20)).count).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await store.hit('k', 20)).count).toBe(1);
  });

  it('resets a key on demand', async () => {
    const store = new InMemoryThrottleStore();
    await store.hit('k', 1000);
    await store.reset('k');
    expect((await store.hit('k', 1000)).count).toBe(1);
  });
});

/**
 * REGRESSION (FIX 1b).
 *
 * reset-password and verify-email have no per-account bucket - the request
 * carries a token, not an address - so their only bucket was per-IP. Behind a
 * proxy (and before FIX 1a, behind ANY proxy, that meant everybody) a couple of
 * dozen anonymous requests an hour 429'd every genuine user trying to finish a
 * password reset, while stopping nothing: the token is 256 bits and single-use,
 * so it is not what an attacker is guessing.
 */
describe('ThrottleGuard enforcePerIp:false (FIX 1b)', () => {
  const RESET: ThrottleOptions = {
    name: 'auth.reset',
    limit: 3,
    windowMs: 60_000,
    enforcePerIp: false,
  };

  it('never 429s on the address bucket alone, however many requests arrive', async () => {
    const g = guard();

    for (let i = 0; i < 50; i += 1) {
      await expect(
        g.canActivate(contextFor(RESET, { ip: '10.0.0.1' }).context),
      ).resolves.toBe(true);
    }
  });

  it('still counts the address, so the pressure remains visible to an operator', async () => {
    const store = new InMemoryThrottleStore();
    const g = guard(store);

    await g.canActivate(contextFor(RESET, { ip: '10.0.0.2' }).context);
    await g.canActivate(contextFor(RESET, { ip: '10.0.0.2' }).context);

    // The bucket exists and has been charged; it simply cannot refuse.
    expect((await store.hit('auth.reset:ip:10.0.0.2', 60_000)).count).toBe(3);
  });

  it('still enforces a per-subject bucket when the route has one', async () => {
    const g = guard();
    const withSubject: ThrottleOptions = { ...RESET, byBodyField: 'email' };
    const attempt = (ip: string): ReturnType<ThrottleGuard['canActivate']> =>
      g.canActivate(contextFor(withSubject, { ip, body: { email: 'victim@example.com' } }).context);

    await attempt('10.0.0.3');
    await attempt('10.0.0.4');
    await attempt('10.0.0.5');
    await expect(attempt('10.0.0.6')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('leaves login enforced per address - that IS the brute-force surface', async () => {
    const g = guard();
    const attempt = (email: string): ReturnType<ThrottleGuard['canActivate']> =>
      g.canActivate(contextFor(LOGIN, { ip: '10.0.0.7', body: { email } }).context);

    await attempt('a@x.co');
    await attempt('b@x.co');
    await attempt('c@x.co');
    // Different account each time: only the address bucket can catch this.
    await expect(attempt('d@x.co')).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

/**
 * A stand-in for the three ioredis commands the store uses. Keeps the unit test
 * hermetic while still exercising the INCR / PTTL / PEXPIRE sequence, including
 * the case the sequence exists to repair: a key that lost its expiry.
 */
class FakeRedis implements ThrottleRedis {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  failing = false;
  quitCalls = 0;
  disconnectCalls = 0;

  async incr(key: string): Promise<number> {
    if (this.failing) throw new Error('ECONNREFUSED');
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async pttl(key: string): Promise<number> {
    if (this.failing) throw new Error('ECONNREFUSED');
    return this.ttls.get(key) ?? -1;
  }

  async pexpire(key: string, ms: number): Promise<unknown> {
    if (this.failing) throw new Error('ECONNREFUSED');
    this.ttls.set(key, ms);
    return 1;
  }

  async del(key: string): Promise<unknown> {
    if (this.failing) throw new Error('ECONNREFUSED');
    this.counts.delete(key);
    this.ttls.delete(key);
    return 1;
  }

  async quit(): Promise<unknown> {
    this.quitCalls += 1;
    return 'OK';
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

/**
 * REGRESSION (FIX 1c): the in-memory counter is per process and the manifests
 * ship `replicas: 2`, so the real limit was 2x the configured one.
 */
describe('RedisThrottleStore (FIX 1c)', () => {
  it('shares one counter across replicas', async () => {
    const redis = new FakeRedis();
    const replicaA = new RedisThrottleStore(redis);
    const replicaB = new RedisThrottleStore(redis);

    expect((await replicaA.hit('auth.login:ip:1.2.3.4', 60_000)).count).toBe(1);
    // The SAME key on another pod continues the count instead of restarting it.
    expect((await replicaB.hit('auth.login:ip:1.2.3.4', 60_000)).count).toBe(2);
    expect((await replicaA.hit('auth.login:ip:1.2.3.4', 60_000)).count).toBe(3);
  });

  it('sets the window expiry once and reports resetAt from the live TTL', async () => {
    const redis = new FakeRedis();
    const store = new RedisThrottleStore(redis);

    const first = await store.hit('k', 60_000);

    expect([...redis.ttls.values()]).toEqual([60_000]);
    expect(first.resetAt).toBeGreaterThan(Date.now());
    expect(first.resetAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('repairs a key that lost its expiry instead of locking an address out forever', async () => {
    const redis = new FakeRedis();
    const store = new RedisThrottleStore(redis);
    await store.hit('k', 60_000);

    // A crash between INCR and PEXPIRE, a failover, an operator PERSIST: the
    // counter survives with no TTL and would otherwise count up forever.
    redis.ttls.clear();

    const repaired = await store.hit('k', 60_000);

    expect(repaired.resetAt).toBeGreaterThan(Date.now());
    expect([...redis.ttls.values()]).toEqual([60_000]);
  });

  it('namespaces its keys so it cannot collide with other Redis users', async () => {
    const redis = new FakeRedis();
    await new RedisThrottleStore(redis).hit('auth.login:ip:1.2.3.4', 1000);

    expect([...redis.counts.keys()]).toEqual(['throttle:auth.login:ip:1.2.3.4']);
  });

  it('degrades to per-process counting when Redis is down - it does not fail open', async () => {
    const redis = new FakeRedis();
    const store = new RedisThrottleStore(redis);
    redis.failing = true;

    // Still counting, just locally: an attacker who knocks Redis over does not
    // thereby get unlimited login attempts.
    expect((await store.hit('k', 60_000)).count).toBe(1);
    expect((await store.hit('k', 60_000)).count).toBe(2);
    expect((await store.hit('k', 60_000)).count).toBe(3);
  });

  it('does not turn a Redis outage into an authentication outage', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const g = guard(new RedisThrottleStore(redis));

    await expect(
      g.canActivate(contextFor(LOGIN, { ip: '1.2.3.4', body: { email: 'a@b.co' } }).context),
    ).resolves.toBe(true);
  });

  it('resumes shared counting once Redis returns', async () => {
    const redis = new FakeRedis();
    const store = new RedisThrottleStore(redis);
    redis.failing = true;
    await store.hit('k', 60_000);

    redis.failing = false;
    const recovered = await store.hit('k', 60_000);

    expect(recovered.count).toBe(1);
    expect(redis.counts.get('throttle:k')).toBe(1);
  });

  it('closes the connection on shutdown', async () => {
    const redis = new FakeRedis();
    await new RedisThrottleStore(redis).onModuleDestroy();

    expect(redis.disconnectCalls).toBe(1);
  });

  it('falls back to QUIT for a client with no disconnect', async () => {
    const redis = new FakeRedis();
    const noDisconnect: ThrottleRedis = {
      incr: (k) => redis.incr(k),
      pttl: (k) => redis.pttl(k),
      pexpire: (k, ms) => redis.pexpire(k, ms),
      del: (k) => redis.del(k),
      quit: () => redis.quit(),
    };

    await new RedisThrottleStore(noDisconnect).onModuleDestroy();

    expect(redis.quitCalls).toBe(1);
  });

  it('clears both the shared and the local counter on reset', async () => {
    const redis = new FakeRedis();
    const store = new RedisThrottleStore(redis);
    await store.hit('k', 60_000);

    await store.reset('k');

    expect(redis.counts.has('throttle:k')).toBe(false);
    expect((await store.hit('k', 60_000)).count).toBe(1);
  });
});

describe('createThrottleStore', () => {
  it('falls back to the per-process store when REDIS_URL is unset, and says so loudly', () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), log: () => undefined };

    const store = createThrottleStore(undefined, logger as unknown as Logger);

    expect(store).toBeInstanceOf(InMemoryThrottleStore);
    expect(warnings.join(' ')).toMatch(/PER PROCESS/);
    expect(warnings.join(' ')).toMatch(/REDIS_URL/);
  });

  it('uses Redis when REDIS_URL is set', () => {
    const logged: string[] = [];
    const logger = { warn: () => undefined, log: (m: string) => logged.push(m) };

    const store = createThrottleStore(
      'redis://127.0.0.1:6399/0',
      logger as unknown as Logger,
    ) as RedisThrottleStore;

    expect(store).toBeInstanceOf(RedisThrottleStore);
    expect(logged.join(' ')).toMatch(/shared across replicas/);
    // lazyConnect, so nothing has dialled anything; close the idle client.
    return store.onModuleDestroy();
  });
});
