import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppExceptionFilter } from '../common/errors';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../common/throttle.store';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthMailer, MAILER_PORT } from './mailer.port';
import { PasswordService } from './password.service';
import { SESSION_COOKIE, SessionService, SessionUser } from './session.service';
import { SessionGuard } from './session.guard';
import { FakePrisma } from './testing/prisma.fake';
import { TokenService } from './token.service';

/**
 * The two new auth routes as a browser actually meets them: real routing, the
 * real ThrottleGuard and SessionGuard, the real validation pipe and exception
 * filter, real status codes and real bytes on the wire.
 *
 * The unit suite proves the service's rules. This one proves the parts that
 * only exist at the HTTP layer and that a service test cannot see:
 *
 *   1. `resend-verification` is BYTE-IDENTICAL for every input. Enumeration
 *      resistance is a property of the response, not of a return value - a
 *      service that resolves in all four cases still leaks if the controller,
 *      the pipe or the exception filter renders them differently.
 *   2. The throttle actually fires on the route, and its 429 carries
 *      `Retry-After`.
 *   3. `onboarding-completed` answers 204 twice, and 401 with no cookie.
 *
 * Plain fetch against a real listening server, matching authz.http.spec.ts.
 * `SessionService` is stubbed - the cookie is just a user id - because session
 * cryptography has its own suite; every other collaborator is the real object.
 */
class RecordingMailer implements AuthMailer {
  readonly verifications: Array<{ email: string; token: string }> = [];
  /** Stands in for "SMTP is down". */
  fail = false;

  async sendEmailVerification(email: string, rawToken: string): Promise<void> {
    if (this.fail) throw new Error('smtp: connection refused');
    this.verifications.push({ email, token: rawToken });
  }

  async sendPasswordReset(): Promise<void> {
    if (this.fail) throw new Error('smtp: connection refused');
  }

  async sendRegistrationAttemptNotice(): Promise<void> {
    if (this.fail) throw new Error('smtp: connection refused');
  }
}

class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

interface HttpResult {
  status: number;
  /** Raw bytes, so "identical response" can be asserted as an identity. */
  text: string;
  body: {
    status?: string;
    error?: { code: string; details?: Record<string, unknown> };
  };
  headers: Headers;
}

interface Harness {
  app: INestApplication;
  prisma: FakePrisma;
  mailer: RecordingMailer;
  service: AuthService;
  post(path: string, init: { ip?: string; cookie?: string; body?: unknown }): Promise<HttpResult>;
}

const PASSWORD = 'correct horse battery';

async function boot(): Promise<Harness> {
  const prisma = new FakePrisma();
  const mailer = new RecordingMailer();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      AuthService,
      PasswordService,
      TokenService,
      SessionGuard,
      { provide: PrismaService, useValue: prisma.asPrisma() },
      { provide: MAILER_PORT, useValue: mailer },
      { provide: SessionService, useClass: StubSessionService },
      { provide: THROTTLE_STORE, useClass: InMemoryThrottleStore },
      {
        provide: ConfigService,
        useValue: { get: (key: string): unknown => key === 'ALLOW_OPEN_REGISTRATION' },
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AppExceptionFilter());
  // One hop, so X-Forwarded-For decides `req.ip` and a test can put two
  // requests in different per-IP buckets. Production sets this from
  // TRUST_PROXY_HOPS in main.ts; without it every request here would share one
  // bucket and the per-address assertions below would prove nothing.
  const express = app.getHttpAdapter().getInstance() as {
    set(key: string, value: unknown): void;
  };
  express.set('trust proxy', 1);
  await app.init();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    prisma,
    mailer,
    service: moduleRef.get(AuthService),
    async post(path, init): Promise<HttpResult> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (init.ip) headers['x-forwarded-for'] = init.ip;
      if (init.cookie) headers.cookie = `${SESSION_COOKIE}=${init.cookie}`;
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(init.body ?? {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        text,
        body: text ? JSON.parse(text) : {},
        headers: response.headers,
      };
    },
  };
}

/** A registered, still-unverified account. Returns its id. */
async function seedUnverified(h: Harness, email: string): Promise<string> {
  await h.service.register({ email, password: PASSWORD });
  const user = await h.prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`seed failed for ${email}`);
  return user.id;
}

describe('POST /v1/auth/resend-verification', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('answers an IDENTICAL 202 for unknown, unverified, verified and mailer-down', async () => {
    await seedUnverified(h, 'unverified@example.com');
    await seedUnverified(h, 'verified@example.com');
    await h.service.verifyEmail({
      token: h.mailer.verifications[h.mailer.verifications.length - 1].token,
    });

    // Each from a distinct source address, so a shared per-IP bucket cannot
    // make one of them differ for a reason unrelated to the address.
    const send = (email: string, ip: string): Promise<HttpResult> =>
      h.post('/v1/auth/resend-verification', { ip, body: { email } });

    const unknown = await send('nobody@example.com', '203.0.113.1');
    const unverified = await send('unverified@example.com', '203.0.113.2');
    const verified = await send('verified@example.com', '203.0.113.3');

    h.mailer.fail = true;
    const mailerDown = await send('unverified@example.com', '203.0.113.4');

    const all = [unknown, unverified, verified, mailerDown];
    for (const res of all) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'accepted' });
      // Nothing else may differ either - a Set-Cookie on one branch would be a
      // perfectly good oracle.
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    // The strongest form of the claim: the bytes are the same.
    expect(new Set(all.map((res) => res.text)).size).toBe(1);
  });

  it('a degraded mailer stays 202 - the trap that was fixed in forgot-password', async () => {
    await seedUnverified(h, 'ada@example.com');
    h.mailer.fail = true;

    const registered = await h.post('/v1/auth/resend-verification', {
      ip: '203.0.113.10',
      body: { email: 'ada@example.com' },
    });
    const unknown = await h.post('/v1/auth/resend-verification', {
      ip: '203.0.113.11',
      body: { email: 'nobody@example.com' },
    });

    // A 500 here for the registered address and a 202 for the unknown one is an
    // enumeration oracle assembled out of an error handler.
    expect(registered.status).toBe(202);
    expect(unknown.status).toBe(202);
  });

  it('rejects a malformed address before anything is sent', async () => {
    const res = await h.post('/v1/auth/resend-verification', {
      ip: '203.0.113.20',
      body: { email: 'not-an-address' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_request');
    expect(h.mailer.verifications).toHaveLength(0);
  });

  it('throttles per IP, and the 429 carries a readable Retry-After', async () => {
    await seedUnverified(h, 'ada@example.com');
    const post = (): Promise<HttpResult> =>
      h.post('/v1/auth/resend-verification', {
        ip: '198.51.100.9',
        body: { email: 'ada@example.com' },
      });

    // limit: 5 per hour; the sixth is refused.
    for (let i = 0; i < 5; i += 1) {
      expect((await post()).status).toBe(202);
    }
    const refused = await post();

    expect(refused.status).toBe(429);
    expect(refused.body.error?.code).toBe('rate_limited');
    // Both forms. The header is the one a cross-origin browser can only read
    // because main.ts now exposes it - see config/cors.ts.
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.body.error?.details?.retry_after_seconds).toEqual(expect.any(Number));
  });

  it('throttles per ADDRESS too, so many sources cannot mail-bomb one account', async () => {
    await seedUnverified(h, 'ada@example.com');
    const post = (ip: string): Promise<HttpResult> =>
      h.post('/v1/auth/resend-verification', { ip, body: { email: 'ada@example.com' } });

    for (let i = 0; i < 5; i += 1) {
      expect((await post(`198.51.100.${i}`)).status).toBe(202);
    }
    // A source address that has spent nothing, aimed at the same target: the
    // per-address bucket is the only thing that can refuse this.
    expect((await post('198.51.100.200')).status).toBe(429);
  });

  it('mails a link that works, and burns it after one use', async () => {
    await seedUnverified(h, 'ada@example.com');
    const before = h.mailer.verifications.length;

    await h.post('/v1/auth/resend-verification', {
      ip: '198.51.100.30',
      body: { email: 'ada@example.com' },
    });

    expect(h.mailer.verifications).toHaveLength(before + 1);
    const { token } = h.mailer.verifications[before];
    await expect(h.service.verifyEmail({ token })).resolves.toMatchObject({
      email_verified: true,
    });
    // Replay of a consumed token is refused, and is not distinguishable from
    // an unknown or an expired one.
    await expect(h.service.verifyEmail({ token })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('POST /v1/auth/onboarding-completed', () => {
  let h: Harness;
  let userId: string;

  beforeEach(async () => {
    h = await boot();
    userId = await seedUnverified(h, 'ada@example.com');
  });

  afterEach(async () => {
    await h.app.close();
  });

  const completedAt = async (id: string): Promise<Date | null> =>
    (await h.prisma.user.findUnique({ where: { id } }))?.onboardingCompletedAt ?? null;

  it('answers 204, and 204 again - completing twice is not an error', async () => {
    const first = await h.post('/v1/auth/onboarding-completed', { cookie: userId });
    expect(first.status).toBe(204);
    expect(first.text).toBe('');
    const at = await completedAt(userId);

    const second = await h.post('/v1/auth/onboarding-completed', { cookie: userId });
    expect(second.status).toBe(204);
    // The recorded instant is the FIRST completion; a replay does not move it.
    expect(await completedAt(userId)).toEqual(at);
  });

  it('is 401 without a session, and writes nothing', async () => {
    const res = await h.post('/v1/auth/onboarding-completed', {});

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
    expect(await completedAt(userId)).toBeNull();
  });

  it('acts on the cookie holder only - one user cannot complete another’s', async () => {
    const other = await seedUnverified(h, 'grace@example.com');

    // There is no field for naming a user, and `forbidNonWhitelisted` turns
    // trying into a 400 rather than a silently ignored property. Either answer
    // is correct; what must never happen is Grace's row moving.
    const res = await h.post('/v1/auth/onboarding-completed', {
      cookie: userId,
      body: { user_id: other },
    });

    expect([204, 400]).toContain(res.status);
    expect(await completedAt(other)).toBeNull();
  });
});
