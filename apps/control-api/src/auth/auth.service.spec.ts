import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AppError } from '../common/errors';
import { AuthService } from './auth.service';
import { AuthMailer } from './mailer.port';
import { PasswordService } from './password.service';
import { SessionService, SessionUser } from './session.service';
import { FakePrisma } from './testing/prisma.fake';
import { TOKEN_TTL_MS, TokenService } from './token.service';

/** Captures the raw tokens that would have been emailed; can also fail on demand. */
class CapturingMailer implements AuthMailer {
  readonly verifications: string[] = [];
  readonly resets: string[] = [];
  readonly registrationNotices: string[] = [];
  /** Stands in for "SMTP is down" (FIX 3). */
  fail = false;

  async sendEmailVerification(_email: string, rawToken: string): Promise<void> {
    if (this.fail) throw new Error('smtp: connection refused');
    this.verifications.push(rawToken);
  }

  async sendPasswordReset(_email: string, rawToken: string): Promise<void> {
    if (this.fail) throw new Error('smtp: connection refused');
    this.resets.push(rawToken);
  }

  async sendRegistrationAttemptNotice(email: string): Promise<void> {
    if (this.fail) throw new Error('smtp: connection refused');
    this.registrationNotices.push(email);
  }
}

/** A Prisma-shaped unique violation for an index the service does not model. */
function unmodelledUniqueViolation(): Error {
  const err = new Error('Unique constraint failed') as Error & {
    code: string;
    meta: { target: string[] };
  };
  err.code = 'P2002';
  err.meta = { target: ['some_other_index'] };
  return err;
}

function fakeResponse(): Response & { cookie: jest.Mock; clearCookie: jest.Mock } {
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  return res as unknown as Response & { cookie: jest.Mock; clearCookie: jest.Mock };
}

interface Harness {
  service: AuthService;
  prisma: FakePrisma;
  passwords: PasswordService;
  tokens: TokenService;
  mailer: CapturingMailer;
  sessions: {
    issue: jest.Mock;
    clear: jest.Mock;
    verify: jest.Mock;
    revoke: jest.Mock;
    revokeAllForUser: jest.Mock;
  };
}

function build(openRegistration: boolean): Harness {
  const prisma = new FakePrisma();
  const passwords = new PasswordService();
  const tokens = new TokenService(prisma.asPrisma());
  const mailer = new CapturingMailer();
  const sessions = {
    issue: jest.fn(),
    clear: jest.fn(),
    verify: jest.fn(),
    revoke: jest.fn(),
    revokeAllForUser: jest.fn().mockResolvedValue(0),
  };
  const config = {
    get: (key: string): unknown =>
      key === 'ALLOW_OPEN_REGISTRATION' ? openRegistration : undefined,
  } as unknown as ConfigService;

  const service = new AuthService(
    prisma.asPrisma(),
    passwords,
    tokens,
    sessions as unknown as SessionService,
    config,
    mailer,
  );

  return { service, prisma, passwords, tokens, mailer, sessions };
}

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';

async function registerUser(h: Harness, email: string = EMAIL): Promise<void> {
  await h.service.register({ email, password: PASSWORD });
}

/**
 * Register and then consume the verification link, i.e. an account that can
 * actually log in. Login now requires a proved address (FIX 5), so a test that
 * wants a usable account has to say so.
 */
async function registerVerifiedUser(h: Harness, email: string = EMAIL): Promise<void> {
  await registerUser(h, email);
  await h.service.verifyEmail({ token: h.mailer.verifications[h.mailer.verifications.length - 1] });
}

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('produces an argon2id hash that never contains the plaintext', async () => {
    const hash = await passwords.hash(PASSWORD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(PASSWORD);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([passwords.hash(PASSWORD), passwords.hash(PASSWORD)]);
    expect(a).not.toEqual(b);
    await expect(passwords.verify(a, PASSWORD)).resolves.toBe(true);
    await expect(passwords.verify(b, PASSWORD)).resolves.toBe(true);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await passwords.hash(PASSWORD);
    await expect(passwords.verify(hash, PASSWORD)).resolves.toBe(true);
    await expect(passwords.verify(hash, `${PASSWORD}!`)).resolves.toBe(false);
    await expect(passwords.verify(hash, '')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    await expect(passwords.verify('not-a-hash', PASSWORD)).resolves.toBe(false);
  });
});

describe('TokenService', () => {
  it('stores only a hash; the raw token never reaches the database', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());

    const issued = await tokens.issue({ type: 'password_reset', email: EMAIL });

    expect(issued.record.tokenHash).toEqual(TokenService.hashToken(issued.raw));
    expect(issued.record.tokenHash).not.toEqual(issued.raw);
    expect(JSON.stringify([...prisma.userTokens.values()])).not.toContain(issued.raw);
  });

  it('is single-use: the second consume of the same token fails', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());
    const issued = await tokens.issue({ type: 'password_reset', email: EMAIL });

    const first = await tokens.consume(issued.raw, 'password_reset');
    expect(first?.id).toEqual(issued.record.id);
    expect(first?.consumedAt).not.toBeNull();

    await expect(tokens.consume(issued.raw, 'password_reset')).resolves.toBeNull();
  });

  it('lets exactly one of two concurrent consumers win', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());
    const issued = await tokens.issue({ type: 'password_reset', email: EMAIL });

    const results = await Promise.all([
      tokens.consume(issued.raw, 'password_reset'),
      tokens.consume(issued.raw, 'password_reset'),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('rejects an expired token', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());
    const issued = await tokens.issue({ type: 'password_reset', email: EMAIL, ttlMs: -1000 });

    expect(issued.record.expiresAt.getTime()).toBeLessThan(Date.now());
    await expect(tokens.consume(issued.raw, 'password_reset')).resolves.toBeNull();
  });

  it('rejects a token presented for the wrong purpose', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());
    const issued = await tokens.issue({ type: 'email_verification', email: EMAIL });

    await expect(tokens.consume(issued.raw, 'password_reset')).resolves.toBeNull();
    await expect(tokens.consume(issued.raw, 'email_verification')).resolves.not.toBeNull();
  });

  it('rejects an unknown token', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());
    await expect(tokens.consume(TokenService.generateRaw(), 'password_reset')).resolves.toBeNull();
  });

  it('revokes outstanding tokens of a type', async () => {
    const prisma = new FakePrisma();
    const tokens = new TokenService(prisma.asPrisma());
    const old = await tokens.issue({ type: 'password_reset', email: EMAIL });
    await tokens.issue({ type: 'email_verification', email: EMAIL });

    expect(await tokens.revokeOutstanding(EMAIL, 'password_reset')).toBe(1);
    await expect(tokens.consume(old.raw, 'password_reset')).resolves.toBeNull();
  });

  it('gives password resets a shorter life than verification links', () => {
    expect(TOKEN_TTL_MS.password_reset).toBeLessThan(TOKEN_TTL_MS.email_verification);
  });
});

describe('AuthService registration', () => {
  it('refuses to register when ALLOW_OPEN_REGISTRATION is off', async () => {
    const h = build(false);

    await expect(registerUser(h)).rejects.toBeInstanceOf(AppError);
    await expect(registerUser(h)).rejects.toMatchObject({ code: 'forbidden' });

    // Nothing was written and no session was handed out.
    expect(h.prisma.users.size).toBe(0);
    expect(h.prisma.organizations.size).toBe(0);
    expect(h.sessions.issue).not.toHaveBeenCalled();
  });

  it('creates user, organization and owner membership in one go', async () => {
    const h = build(true);

    await h.service.register({ email: 'Ada@Example.com ', password: PASSWORD, name: 'Ada' });

    const stored = [...h.prisma.users.values()][0];
    expect(stored.email).toBe(EMAIL);
    expect(stored.emailVerifiedAt).toBeNull();
    expect(h.prisma.organizations.size).toBe(1);
    expect([...h.prisma.members.values()][0].role).toBe('owner');
    expect(h.mailer.verifications).toHaveLength(1);
  });

  it('never stores the password in the clear', async () => {
    const h = build(true);
    await registerUser(h);

    const stored = [...h.prisma.users.values()][0];
    expect(stored.passwordHash).not.toContain(PASSWORD);
    await expect(h.passwords.verify(stored.passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('REGRESSION (FIX 2): a taken address is indistinguishable from a free one', async () => {
    const h = build(true);
    await registerUser(h);

    // Same shape, same status, no body, no cookie - the 201/409 split let an
    // attacker walk a list of addresses and check which ones had accounts.
    await expect(registerUser(h)).resolves.toBeUndefined();
    await expect(registerUser(h, 'someone-new@example.com')).resolves.toBeUndefined();

    // The collision created nothing (and the organization it tried to create
    // was rolled back with it).
    expect(h.prisma.users.size).toBe(2);
    expect(h.prisma.organizations.size).toBe(2);

    // The only party told about the collision is the address owner.
    expect(h.mailer.registrationNotices).toEqual([EMAIL]);
  });

  it('REGRESSION (FIX 2): registration hands out no session cookie either', async () => {
    const h = build(true);
    await registerUser(h);

    // A Set-Cookie on the success path alone would re-open the oracle the 202
    // closes.
    expect(h.sessions.issue).not.toHaveBeenCalled();
  });

  it('REGRESSION (FIX 1): retries a lost organizations.slug race instead of lying', async () => {
    const h = build(true);
    await registerUser(h, 'info@acme.com');

    // Model READ COMMITTED: the in-transaction SELECT cannot see the other
    // transaction's uncommitted row, so it reports the contended slug as free
    // and only the INSERT discovers otherwise.
    h.prisma.organization.findUnique = async () => null;

    await expect(registerUser(h, 'info@globex.com')).resolves.toBeUndefined();

    // Both signups landed. Before the fix the second was told "An account with
    // that email already exists" - a false message on a request that would have
    // succeeded on a retry the caller was never told to make.
    expect(h.prisma.users.size).toBe(2);
    expect([...h.prisma.users.values()].map((u) => u.email)).toEqual([
      'info@acme.com',
      'info@globex.com',
    ]);

    const slugs = [...h.prisma.organizations.values()].map((o) => o.slug);
    expect(slugs[0]).toBe('info');
    expect(slugs[1]).toMatch(/^info-/);
    expect(h.mailer.registrationNotices).toHaveLength(0);
    expect(h.mailer.verifications).toHaveLength(2);
  });

  it('REGRESSION (FIX 1): gives up on the slug with a slug error, not an email one', async () => {
    const h = build(true);
    h.prisma.organization.findUnique = async () => null;
    h.prisma.organization.create = async () => {
      const err = new Error('Unique constraint failed') as Error & {
        code: string;
        meta: { target: string[] };
      };
      err.code = 'P2002';
      err.meta = { target: ['slug'] };
      throw err;
    };

    await expect(registerUser(h)).rejects.toMatchObject({ code: 'conflict' });
    await expect(registerUser(h)).rejects.toThrow(/organization slug/i);
    expect(h.prisma.users.size).toBe(0);
  });

  it('REGRESSION (FIX 1): a P2002 from an unmodelled index surfaces, not laundered', async () => {
    const h = build(true);
    h.prisma.organizationMember.create = async () => {
      throw unmodelledUniqueViolation();
    };

    // Reporting this as "email taken" would hide a real bug behind a friendly
    // 409 forever.
    await expect(registerUser(h)).rejects.toThrow('Unique constraint failed');
    expect(h.mailer.registrationNotices).toHaveLength(0);
  });

  it('REGRESSION (FIX 3): a dead mailer does not 500 a committed signup', async () => {
    const h = build(true);
    h.mailer.fail = true;

    await expect(registerUser(h)).resolves.toBeUndefined();

    // The account exists and is intact; before the fix the caller got a 500,
    // retried, and was told the address was taken - with no session and no
    // verification mail ever sent.
    expect(h.prisma.users.size).toBe(1);
    expect(h.prisma.members.size).toBe(1);
  });
});

describe('AuthService login', () => {
  it('issues a session for correct credentials', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    h.sessions.issue.mockClear();

    const user = await h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse());

    expect(user.email).toBe(EMAIL);
    expect(h.sessions.issue).toHaveBeenCalledTimes(1);
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const h = build(true);
    await registerVerifiedUser(h);

    const capture = async (email: string, password: string): Promise<AppError> => {
      try {
        await h.service.login({ email, password }, fakeResponse());
      } catch (err) {
        return err as AppError;
      }
      throw new Error('expected login to be rejected');
    };

    const wrong = await capture(EMAIL, 'wrong password here');
    const unknown = await capture('nobody@example.com', PASSWORD);

    expect(wrong.code).toBe('unauthenticated');
    expect(unknown.code).toBe('unauthenticated');
    expect(wrong.message).toEqual(unknown.message);
  });

  it('refuses a disabled account without saying so', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    const stored = [...h.prisma.users.values()][0];
    h.prisma.users.set(stored.id, { ...stored, disabledAt: new Date() });

    await expect(
      h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

/**
 * REGRESSION (FIX 5): login never looked at `emailVerifiedAt`.
 *
 * With open registration that meant anyone could sign up with an address they
 * did not control - a colleague's, a customer's - and immediately hold a
 * working account and an organization they owned. Verification existed and was
 * simply never required.
 */
describe('AuthService login requires a verified email (FIX 5)', () => {
  it('refuses an unverified account even with the correct password', async () => {
    const h = build(true);
    await registerUser(h);
    h.sessions.issue.mockClear();

    await expect(
      h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'email_not_verified' });
    expect(h.sessions.issue).not.toHaveBeenCalled();
  });

  it('lets the same account in once the link is used', async () => {
    const h = build(true);
    await registerUser(h);

    await expect(
      h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'email_not_verified' });

    await h.service.verifyEmail({ token: h.mailer.verifications[0] });

    const user = await h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse());
    expect(user.email_verified).toBe(true);
  });

  it('does not enumerate: the code is only reachable with the right password', async () => {
    const h = build(true);
    await registerUser(h);

    const capture = async (email: string, password: string): Promise<AppError> => {
      try {
        await h.service.login({ email, password }, fakeResponse());
      } catch (err) {
        return err as AppError;
      }
      throw new Error('expected login to be rejected');
    };

    // Unregistered address, and a registered-but-unverified one with the wrong
    // password, are indistinguishable. Only someone who already knows the
    // password sees email_not_verified, and they already know the account exists.
    const unknown = await capture('nobody@example.com', PASSWORD);
    const wrongPassword = await capture(EMAIL, 'wrong password here');
    const correctPassword = await capture(EMAIL, PASSWORD);

    expect(unknown.code).toBe('unauthenticated');
    expect(wrongPassword.code).toBe('unauthenticated');
    expect(unknown.message).toEqual(wrongPassword.message);
    expect(correctPassword.code).toBe('email_not_verified');
  });

  it('keeps disabled ahead of unverified, so a disabled account still says nothing', async () => {
    const h = build(true);
    await registerUser(h);
    const stored = [...h.prisma.users.values()][0];
    h.prisma.users.set(stored.id, { ...stored, disabledAt: new Date() });

    await expect(
      h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('answers 403, not 401, so a client can tell "verify" from "wrong password"', async () => {
    const h = build(true);
    await registerUser(h);

    const err = await h.service
      .login({ email: EMAIL, password: PASSWORD }, fakeResponse())
      .catch((e: AppError) => e);

    expect((err as AppError).getStatus()).toBe(403);
    expect((err as AppError).message).not.toMatch(/exist|registered|unknown/i);
  });
});

describe('AuthService email verification', () => {
  it('verifies once and rejects the token thereafter', async () => {
    const h = build(true);
    await registerUser(h);
    const token = h.mailer.verifications[0];

    const verified = await h.service.verifyEmail({ token });
    expect(verified.email_verified).toBe(true);

    await expect(h.service.verifyEmail({ token })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects an expired verification token', async () => {
    const h = build(true);
    await registerUser(h);

    // Age every outstanding token past its expiry.
    for (const [id, t] of h.prisma.userTokens) {
      h.prisma.userTokens.set(id, { ...t, expiresAt: new Date(Date.now() - 1000) });
    }

    await expect(
      h.service.verifyEmail({ token: h.mailer.verifications[0] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect([...h.prisma.users.values()][0].emailVerifiedAt).toBeNull();
  });
});

describe('AuthService password reset', () => {
  it('does not reveal whether an address is registered', async () => {
    const h = build(true);
    await expect(h.service.forgotPassword('nobody@example.com')).resolves.toBeUndefined();
    expect(h.mailer.resets).toHaveLength(0);
  });

  it('REGRESSION (FIX 3): a dead mailer answers 202 for known and unknown alike', async () => {
    const h = build(true);
    await registerUser(h);
    h.mailer.fail = true;

    // Before the fix the unknown address returned early with 202 while the
    // registered one reached the mailer and threw - so a degraded transport was
    // a perfect account-enumeration oracle: 202 means "no account", 500 means
    // "account".
    await expect(h.service.forgotPassword('nobody@example.com')).resolves.toBeUndefined();
    await expect(h.service.forgotPassword(EMAIL)).resolves.toBeUndefined();
  });

  it('resets the password, kills the session, and burns the token', async () => {
    const h = build(true);
    await registerUser(h);
    await h.service.forgotPassword(EMAIL);
    const token = h.mailer.resets[0];
    const res = fakeResponse();

    const next = 'a brand new passphrase';
    await h.service.resetPassword({ token, password: next }, res);

    const stored = [...h.prisma.users.values()][0];
    await expect(h.passwords.verify(stored.passwordHash, next)).resolves.toBe(true);
    await expect(h.passwords.verify(stored.passwordHash, PASSWORD)).resolves.toBe(false);
    expect(h.sessions.clear).toHaveBeenCalled();

    // REGRESSION (FIX 8): a reset answers a suspected compromise, so every
    // session the attacker may already hold has to die with the old password.
    expect(h.sessions.revokeAllForUser).toHaveBeenCalledWith(stored.id, 'password_reset');

    await expect(
      h.service.resetPassword({ token, password: 'yet another passphrase' }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('invalidates an earlier reset link when a new one is requested', async () => {
    const h = build(true);
    await registerUser(h);
    await h.service.forgotPassword(EMAIL);
    await h.service.forgotPassword(EMAIL);

    const [first, second] = h.mailer.resets;
    await expect(
      h.service.resetPassword({ token: first, password: 'passphrase number one' }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      h.service.resetPassword({ token: second, password: 'passphrase number two' }, fakeResponse()),
    ).resolves.toBeUndefined();
  });

  it('rejects an expired reset token', async () => {
    const h = build(true);
    await registerUser(h);
    await h.service.forgotPassword(EMAIL);
    for (const [id, t] of h.prisma.userTokens) {
      h.prisma.userTokens.set(id, { ...t, expiresAt: new Date(Date.now() - 1000) });
    }

    await expect(
      h.service.resetPassword({ token: h.mailer.resets[0], password: 'expired attempt pw' }, fakeResponse()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('AuthService logout', () => {
  it('clears the cookie even without a valid session', async () => {
    const h = build(true);
    const res = fakeResponse();
    h.sessions.verify.mockResolvedValue(null);

    await h.service.logout(res, 'garbage-cookie');

    expect(h.sessions.clear).toHaveBeenCalledWith(res);
    expect(h.sessions.revoke).not.toHaveBeenCalled();
  });

  it('REGRESSION (FIX 8): revokes the session, not just the cookie', async () => {
    const h = build(true);
    const res = fakeResponse();
    h.sessions.verify.mockResolvedValue({
      userId: 'usr_1',
      email: EMAIL,
      sessionId: 'ses_abc',
    });

    await h.service.logout(res, 'a-valid-cookie');

    // Clearing the cookie only affects the browser doing the logging out; a
    // copy taken off the machine stayed valid until expiry.
    expect(h.sessions.revoke).toHaveBeenCalledWith('ses_abc', 'logout');
    expect(h.sessions.clear).toHaveBeenCalledWith(res);
  });

  it('is idempotent when logging out twice', async () => {
    const h = build(true);
    h.sessions.verify.mockResolvedValue({ userId: 'usr_1', email: EMAIL, sessionId: 'ses_abc' });

    await h.service.logout(fakeResponse(), 'c');
    await h.service.logout(fakeResponse(), 'c');

    expect(h.sessions.revoke).toHaveBeenCalledTimes(2);
  });
});

describe('AuthService session issuance', () => {
  it('records the request context on the session row', async () => {
    const h = build(true);
    const ctx = { ipAddress: '198.51.100.7', userAgent: 'curl/8' };
    await registerVerifiedUser(h);

    await h.service.login({ email: EMAIL, password: PASSWORD }, fakeResponse(), ctx);

    expect(h.sessions.issue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ email: EMAIL }),
      ctx,
    );
  });
});

describe('AuthService resend verification', () => {
  /**
   * The property this route exists to hold. A caller must not be able to tell
   * these four apart, and the failure mode that historically broke it was not
   * the happy path but the DEGRADED one: forgot-password used to 500 for a
   * registered address and 202 for an unknown one whenever SMTP was down,
   * assembling an oracle out of an error handler.
   */
  it('answers identically for unknown, unverified, already-verified and mailer-down', async () => {
    const h = build(true);
    await registerUser(h, 'unverified@example.com');
    await registerVerifiedUser(h, 'verified@example.com');

    await expect(h.service.resendVerification('nobody@example.com')).resolves.toBeUndefined();
    await expect(h.service.resendVerification('unverified@example.com')).resolves.toBeUndefined();
    await expect(h.service.resendVerification('verified@example.com')).resolves.toBeUndefined();

    h.mailer.fail = true;
    await expect(h.service.resendVerification('unverified@example.com')).resolves.toBeUndefined();
    await expect(h.service.resendVerification('nobody@example.com')).resolves.toBeUndefined();
  });

  it('REGRESSION: a token-store failure is swallowed too, not just the mailer', async () => {
    const h = build(true);
    await registerUser(h);
    // A dead mailer is not the only way this can throw. If the token write
    // failed, an unhandled error here would 500 for a registered address and
    // 202 for an unknown one - the identical oracle, reached by a different
    // route.
    jest
      .spyOn(h.tokens, 'revokeOutstanding')
      .mockRejectedValueOnce(new Error('connection terminated'));

    await expect(h.service.resendVerification(EMAIL)).resolves.toBeUndefined();
  });

  it('mails a fresh, working link to an unverified address', async () => {
    const h = build(true);
    await registerUser(h);
    const fromRegistration = h.mailer.verifications.length;

    await h.service.resendVerification(EMAIL.toUpperCase());

    // Also proves the address is normalised: the caller typed it in caps.
    expect(h.mailer.verifications).toHaveLength(fromRegistration + 1);
    const user = await h.service.verifyEmail({ token: h.mailer.verifications[1] });
    expect(user.email).toBe(EMAIL);
  });

  it('kills the previous link, so only the newest email works', async () => {
    const h = build(true);
    await registerUser(h);
    await h.service.resendVerification(EMAIL);

    const [first, second] = h.mailer.verifications;
    await expect(h.service.verifyEmail({ token: first })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(h.service.verifyEmail({ token: second })).resolves.toMatchObject({
      email_verified: true,
    });
  });

  it('a consumed resend token cannot be replayed', async () => {
    const h = build(true);
    await registerUser(h);
    await h.service.resendVerification(EMAIL);
    const token = h.mailer.verifications[1];

    await h.service.verifyEmail({ token });
    await expect(h.service.verifyEmail({ token })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('sends nothing for a verified or an unknown address', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    const sent = h.mailer.verifications.length;

    await h.service.resendVerification(EMAIL);
    await h.service.resendVerification('nobody@example.com');

    expect(h.mailer.verifications).toHaveLength(sent);
  });
});

describe('AuthService onboarding completion', () => {
  async function sessionFor(h: Harness, email: string): Promise<SessionUser> {
    const user = await h.prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`no such test user: ${email}`);
    return { userId: user.id, email: user.email, sessionId: `ses_${user.id}` };
  }

  it('records the instant and exposes it on the session response', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    const session = await sessionFor(h, EMAIL);

    expect((await h.service.currentUser(session)).onboarding_completed_at).toBeNull();

    const at = await h.service.completeOnboarding(session);

    expect(at).toBeInstanceOf(Date);
    // ISO-8601, which is what the client is promised - not a Date, not epoch ms.
    expect((await h.service.currentUser(session)).onboarding_completed_at).toBe(
      at?.toISOString(),
    );
  });

  it('is idempotent, and the recorded instant does not drift forward', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    const session = await sessionFor(h, EMAIL);

    const first = await h.service.completeOnboarding(session);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await h.service.completeOnboarding(session);

    // Completing twice is a success, not a conflict, and the FIRST completion
    // is the one on record - a retrying client must not rewrite history.
    expect(second?.toISOString()).toBe(first?.toISOString());
  });

  it('audits the transition once, however many times it is called', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    const session = await sessionFor(h, EMAIL);

    await h.service.completeOnboarding(session);
    await h.service.completeOnboarding(session);
    await h.service.completeOnboarding(session);

    const entries = h.prisma.auditLogs.filter(
      (row) => row.action === 'user.onboarding_completed',
    );
    // A replay must not be able to flood audit_logs.
    expect(entries).toHaveLength(1);
  });

  it('touches only the calling user - one account cannot complete another’s', async () => {
    const h = build(true);
    await registerVerifiedUser(h, 'ada@example.com');
    await registerVerifiedUser(h, 'grace@example.com');
    const ada = await sessionFor(h, 'ada@example.com');
    const grace = await sessionFor(h, 'grace@example.com');

    await h.service.completeOnboarding(ada);

    // The id comes off the verified session and nowhere else; there is no body
    // or path parameter naming a user, so this is a property of the signature
    // as much as of the query. Assert the row, not just the response.
    expect((await h.service.currentUser(grace)).onboarding_completed_at).toBeNull();
    const graceRow = await h.prisma.user.findUnique({ where: { id: grace.userId } });
    expect(graceRow?.onboardingCompletedAt).toBeNull();
  });

  it('lets two concurrent completions race, and exactly one writes', async () => {
    const h = build(true);
    await registerVerifiedUser(h);
    const session = await sessionFor(h, EMAIL);

    const [a, b] = await Promise.all([
      h.service.completeOnboarding(session),
      h.service.completeOnboarding(session),
    ]);

    expect(a?.toISOString()).toBe(b?.toISOString());
    expect(
      h.prisma.auditLogs.filter((row) => row.action === 'user.onboarding_completed'),
    ).toHaveLength(1);
  });
});
