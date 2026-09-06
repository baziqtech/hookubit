import { ExpressAdapter } from '@nestjs/platform-express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { applyTrustProxy } from './trust-proxy';

/**
 * REGRESSION (FIX 1a).
 *
 * The rate limiter buckets by `req.ip`, and `req.ip` is meaningless until
 * `trust proxy` is set - which main.ts never did. These tests pin the two
 * failure modes that make the limiter useless in opposite directions: not
 * trusting the proxy (one bucket for the entire platform, so a trickle of
 * anonymous requests locks everyone out of login) and trusting too many hops
 * (a fresh bucket per forged X-Forwarded-For, so no limit at all).
 *
 * They run against a real Express instance - the one Nest itself builds - not a
 * mock, because the behaviour under test IS Express's.
 */
interface ExpressLike {
  set(setting: string, value: unknown): unknown;
  get(path: string, handler: (req: { ip?: string }, res: ExpressRes) => void): unknown;
  listen(port: number): Server;
}
interface ExpressRes {
  json(body: unknown): void;
}

function serverWithHops(hops: unknown): { server: Server; port: number } {
  const app = new ExpressAdapter().getInstance<ExpressLike>();
  applyTrustProxy(app, hops);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0);
  return { server, port: (server.address() as AddressInfo).port };
}

async function ipSeenBy(port: number, forwardedFor?: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/ip`, {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
  return ((await res.json()) as { ip: string }).ip;
}

/** Runs `fn` against a throwaway server on the given hop count. */
async function withHops(hops: unknown, fn: (port: number) => Promise<void>): Promise<void> {
  const { server, port } = serverWithHops(hops);
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('applyTrustProxy against real Express', () => {
  it('ignores X-Forwarded-For entirely with 0 hops', async () => {
    await withHops(0, async (port) => {
      expect(await ipSeenBy(port, '203.0.113.9')).not.toBe('203.0.113.9');
    });
  });

  it('derives req.ip from X-Forwarded-For once a hop is configured', async () => {
    // The bug: with no `trust proxy`, every request behind the ingress reported
    // the ingress pod's own address and shared a single rate-limit bucket.
    await withHops(1, async (port) => {
      expect(await ipSeenBy(port, '203.0.113.9')).toBe('203.0.113.9');
      expect(await ipSeenBy(port, '198.51.100.7')).toBe('198.51.100.7');
    });
  });

  it('gives two clients behind the same proxy two different buckets', async () => {
    await withHops(1, async (port) => {
      expect(await ipSeenBy(port, '203.0.113.1')).not.toBe(await ipSeenBy(port, '203.0.113.2'));
    });
  });

  it('does not let a client forge extra hops to escape its bucket', async () => {
    // One real proxy. The client prepends junk; Express must still charge the
    // address the proxy actually observed, not the attacker's left-most entry.
    await withHops(1, async (port) => {
      const ip = await ipSeenBy(port, '1.2.3.4, 9.9.9.9, 203.0.113.5');
      expect(ip).toBe('203.0.113.5');
      expect(ip).not.toBe('1.2.3.4');
    });
  });

  it('counts hops outward from this process, so a 2-proxy chain resolves the client', async () => {
    await withHops(2, async (port) => {
      expect(await ipSeenBy(port, 'forged.example, 203.0.113.5, 10.0.0.1')).toBe('203.0.113.5');
    });
  });
});

describe('applyTrustProxy configuration', () => {
  function recorder(): { app: { set(s: string, v: unknown): void }; values: unknown[] } {
    const values: unknown[] = [];
    return { app: { set: (_s, v) => void values.push(v) }, values };
  }

  it('passes the exact hop count through, never `true`', () => {
    const { app, values } = recorder();

    expect(applyTrustProxy(app, 3)).toBe(3);
    expect(values).toEqual([3]);
    // `true` walks X-Forwarded-For to the left-most entry, which is entirely
    // attacker-chosen: it is worse than no rate limiting, because it looks like
    // there is some.
    expect(values).not.toContain(true);
  });

  it.each([undefined, null, 'true', 'lots', -1, 1.5, NaN, {}])(
    'falls back to 0 hops for the unusable value %p rather than trusting a header',
    (value) => {
      const { app, values } = recorder();

      expect(applyTrustProxy(app, value)).toBe(0);
      expect(values).toEqual([0]);
    },
  );

  it('accepts a numeric string, since environment variables arrive as strings', () => {
    const { app, values } = recorder();

    expect(applyTrustProxy(app, '2')).toBe(2);
    expect(values).toEqual([2]);
  });
});
