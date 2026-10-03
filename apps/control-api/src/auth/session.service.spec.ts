import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { Response } from 'express';
import { SessionService } from './session.service';
import { FakePrisma } from './testing/prisma.fake';

function fakeResponse(): Response & { cookie: jest.Mock; clearCookie: jest.Mock } {
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  return res as unknown as Response & { cookie: jest.Mock; clearCookie: jest.Mock };
}

function build(appEnv: string | undefined = 'test'): {
  sessions: SessionService;
  prisma: FakePrisma;
  jwt: JwtService;
} {
  const prisma = new FakePrisma();
  const jwt = new JwtService({ secret: 'x'.repeat(48) });
  // A ConfigService that answers `appEnv` to everything, including an APP_ENV
  // that was never set - which is precisely the case FIX 3 has to fail safe on.
  const config = { get: () => appEnv } as unknown as ConfigService;
  // verify() joins the account row (FIX 4), so the users have to exist.
  seedUser(prisma, 'usr_1', 'ada@example.com');
  seedUser(prisma, 'usr_2', 'bob@example.com');
  return { sessions: new SessionService(jwt, prisma.asPrisma(), config), prisma, jwt };
}

function seedUser(prisma: FakePrisma, id: string, email: string): User {
  const user: User = {
    id,
    email,
    name: null,
    passwordHash: 'x',
    emailVerifiedAt: null,
    lastLoginAt: null,
    disabledAt: null,
    onboardingCompletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  prisma.users.set(id, user);
  return user;
}

const USER = { userId: 'usr_1', email: 'ada@example.com' };

async function issued(): Promise<{
  sessions: SessionService;
  prisma: FakePrisma;
  jwt: JwtService;
  token: string;
  sessionId: string;
}> {
  const h = build();
  const res = fakeResponse();
  const sessionId = await h.sessions.issue(res, USER, { ipAddress: '1.2.3.4' });
  const token = res.cookie.mock.calls[0][1] as string;
  return { ...h, token, sessionId };
}

describe('SessionService revocation (FIX 8)', () => {
  it('writes a session row and puts its id in the cookie', async () => {
    const h = await issued();

    expect(h.prisma.sessions.size).toBe(1);
    const row = h.prisma.sessions.get(h.sessionId);
    expect(row?.userId).toBe(USER.userId);
    expect(row?.revokedAt).toBeNull();
    expect(row?.ipAddress).toBe('1.2.3.4');
    await expect(h.sessions.verify(h.token)).resolves.toEqual({
      userId: USER.userId,
      email: USER.email,
      sessionId: h.sessionId,
    });
  });

  it('sets an HTTP-only cookie, so the token never reaches JavaScript', async () => {
    const h = build();
    const res = fakeResponse();
    await h.sessions.issue(res, USER);

    const [name, , options] = res.cookie.mock.calls[0];
    expect(name).toBe('session');
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('REGRESSION: a copied token stops working once the session is revoked', async () => {
    const h = await issued();
    // The attacker's copy, taken before logout.
    const stolen = h.token;
    await expect(h.sessions.verify(stolen)).resolves.not.toBeNull();

    await h.sessions.revoke(h.sessionId, 'logout');

    // The JWT signature is still perfectly valid; the session is not.
    await expect(h.jwt.verifyAsync(stolen)).resolves.toBeDefined();
    await expect(h.sessions.verify(stolen)).resolves.toBeNull();
  });

  it('revoking is idempotent and records only the first reason', async () => {
    const h = await issued();
    await h.sessions.revoke(h.sessionId, 'logout');
    const first = h.prisma.sessions.get(h.sessionId)?.revokedAt;

    await h.sessions.revoke(h.sessionId, 'admin');

    expect(h.prisma.sessions.get(h.sessionId)?.revokedAt).toEqual(first);
    expect(h.prisma.sessions.get(h.sessionId)?.revokedReason).toBe('logout');
  });

  it('revoking an unknown session is a no-op, not an error', async () => {
    const h = build();
    await expect(h.sessions.revoke('ses_nope', 'logout')).resolves.toBeUndefined();
  });

  it('signs a user out everywhere', async () => {
    const h = build();
    const tokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = fakeResponse();
      await h.sessions.issue(res, USER);
      tokens.push(res.cookie.mock.calls[0][1] as string);
    }
    const otherRes = fakeResponse();
    await h.sessions.issue(otherRes, { userId: 'usr_2', email: 'bob@example.com' });
    const otherToken = otherRes.cookie.mock.calls[0][1] as string;

    expect(await h.sessions.revokeAllForUser(USER.userId, 'password_reset')).toBe(3);

    for (const token of tokens) {
      await expect(h.sessions.verify(token)).resolves.toBeNull();
    }
    // Another user's session is untouched.
    await expect(h.sessions.verify(otherToken)).resolves.not.toBeNull();
  });

  it('rejects an expired session row even while the JWT is still in date', async () => {
    const h = await issued();
    const row = h.prisma.sessions.get(h.sessionId)!;
    h.prisma.sessions.set(h.sessionId, { ...row, expiresAt: new Date(Date.now() - 1000) });

    await expect(h.sessions.verify(h.token)).resolves.toBeNull();
  });

  it('rejects a valid JWT whose session row was deleted', async () => {
    const h = await issued();
    h.prisma.sessions.delete(h.sessionId);

    await expect(h.sessions.verify(h.token)).resolves.toBeNull();
  });

  it('rejects a token signed by a different deployment', async () => {
    const h = build();
    const foreign = new JwtService({ secret: 'y'.repeat(48) });
    const forged = await foreign.signAsync({ sub: 'usr_1', email: 'a@b.co', sid: 'ses_x' });

    await expect(h.sessions.verify(forged)).resolves.toBeNull();
    await expect(h.sessions.verify('garbage')).resolves.toBeNull();
  });

  it('rejects a token whose subject no longer matches its session row', async () => {
    const h = await issued();
    const row = h.prisma.sessions.get(h.sessionId)!;
    h.prisma.sessions.set(h.sessionId, { ...row, userId: 'usr_someone_else' });

    await expect(h.sessions.verify(h.token)).resolves.toBeNull();
  });

  it('REGRESSION (FIX 4): rejects a live session whose account has been disabled', async () => {
    const h = await issued();
    await expect(h.sessions.verify(h.token)).resolves.not.toBeNull();

    const user = h.prisma.users.get(USER.userId)!;
    h.prisma.users.set(USER.userId, { ...user, disabledAt: new Date() });

    // The JWT is still signed, still in date, and its session row is still
    // live - disabling the account used to buy nothing for up to seven days.
    await expect(h.sessions.verify(h.token)).resolves.toBeNull();
  });

  it('REGRESSION (FIX 4): rejects a session whose account no longer exists', async () => {
    const h = await issued();
    h.prisma.users.delete(USER.userId);

    await expect(h.sessions.verify(h.token)).resolves.toBeNull();
  });

  it('rejects a pre-fix stateless token that carries no session id', async () => {
    const h = build();
    const legacy = await h.jwt.signAsync({ sub: USER.userId, email: USER.email });

    await expect(h.sessions.verify(legacy)).resolves.toBeNull();
  });
});

/**
 * REGRESSION (FIX 3): the Secure flag was decided by `APP_ENV !== 'development'`.
 *
 * That is an opt-IN to security, and it only holds while APP_ENV is exactly one
 * of the four expected values. Unset, blank, or misspelled in a Helm values file
 * ('prod', 'Production'), the read fell through to the insecure branch and the
 * session cookie went out WITHOUT Secure - one plaintext request away from being
 * handed to anyone on the path. Now only the two environments that genuinely
 * have no TLS opt out, and everything else fails safe.
 */
describe('SessionService cookie Secure flag (FIX 3)', () => {
  /**
   * Built inline rather than through `build(appEnv)`: passing `undefined` to a
   * parameter with a default gets the default, and "APP_ENV was never set" is
   * the exact case under test.
   */
  async function secureFlagFor(appEnv: string | undefined): Promise<boolean> {
    const prisma = new FakePrisma();
    seedUser(prisma, 'usr_1', 'ada@example.com');
    const config = { get: (): string | undefined => appEnv } as unknown as ConfigService;
    const sessions = new SessionService(
      new JwtService({ secret: 'x'.repeat(48) }),
      prisma.asPrisma(),
      config,
    );
    const res = fakeResponse();

    await sessions.issue(res, USER);

    return (res.cookie.mock.calls[0][2] as { secure: boolean }).secure;
  }

  it.each(['development', 'test'])('omits Secure for %s, which has no TLS', async (appEnv) => {
    expect(await secureFlagFor(appEnv)).toBe(false);
  });

  it.each(['staging', 'production'])('sets Secure for %s', async (appEnv) => {
    expect(await secureFlagFor(appEnv)).toBe(true);
  });

  it.each([undefined, '', '  ', 'prod', 'Production', 'PRODUCTION', 'developement', 'live'])(
    'fails safe with Secure for the unrecognised APP_ENV %j',
    async (appEnv) => {
      expect(await secureFlagFor(appEnv)).toBe(true);
    },
  );

  it('keeps the cookie HttpOnly and SameSite regardless of environment', async () => {
    const h = build('production');
    const res = fakeResponse();
    await h.sessions.issue(res, USER);

    expect(res.cookie.mock.calls[0][2]).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('clears the cookie with the same Secure flag it was set with', async () => {
    const h = build('production');
    const res = fakeResponse();

    h.sessions.clear(res);

    expect(res.clearCookie.mock.calls[0][1]).toMatchObject({ secure: true, httpOnly: true });
  });
});
