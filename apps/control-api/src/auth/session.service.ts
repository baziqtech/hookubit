import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CookieOptions, Response } from 'express';
import { newId } from '../common/ids';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

export const SESSION_COOKIE = 'session';

/** 7 days. Long enough to be usable, short enough to bound a stolen cookie. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SessionRevocationReason = 'logout' | 'password_reset' | 'admin' | 'expired';

export interface SessionUser {
  userId: string;
  email: string;
  /** `sessions.id`. Present on every session issued after the revocation fix. */
  sessionId: string;
}

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

interface SessionClaims {
  sub: string;
  email: string;
  /** sessions.id - the handle that makes revocation possible. */
  sid: string;
}

/**
 * Browser sessions (ARCHITECTURE.md 9).
 *
 * The cookie is a signed JWT in an HTTP-only cookie, so it never reaches
 * JavaScript or localStorage. It is NOT stateless: the JWT carries `sid` and
 * every verification checks the matching `sessions` row.
 *
 * That extra lookup is the whole point. A purely stateless token cannot be
 * withdrawn - logout cleared the cookie in the browser doing the logging out,
 * while a copy taken off the machine stayed valid until expiry, and a password
 * reset could not evict an attacker who already held one. With a row per
 * session, logout revokes that session, a password reset revokes every session
 * the user has, and "sign out everywhere" is one UPDATE.
 *
 * Cost: one indexed primary-key lookup per authenticated request. The
 * alternative - a token-version integer on `users` - costs the same lookup and
 * cannot express "sign out this one device", so it buys nothing.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  /**
   * The only APP_ENVs served over plain HTTP. `env.schema.ts` already rejects
   * any APP_ENV outside development|test|staging|production, so this set is
   * belt-and-braces for a SessionService constructed outside that validation.
   */
  private static readonly PLAINTEXT_ENVS = new Set(['development', 'test']);
  private readonly secure: boolean;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Explicit opt-OUT, not opt-in (FIX 3). This read used to be
    // `APP_ENV !== 'development'`, which is only safe while APP_ENV is exactly
    // one of the four expected values: an unset, blank or misspelled APP_ENV
    // ('prod', 'Production', a typo in a Helm value) took the "not development"
    // branch by accident and shipped the session cookie WITHOUT Secure, so a
    // single plaintext request would hand it over. Now only the two values that
    // genuinely have no TLS turn Secure off; anything unrecognised fails safe
    // and gets a Secure cookie.
    this.secure = !SessionService.PLAINTEXT_ENVS.has(config.get<string>('APP_ENV') ?? '');
  }

  private cookieOptions(maxAgeMs: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  async issue(
    res: Response,
    user: { userId: string; email: string },
    ctx: SessionContext = {},
  ): Promise<string> {
    const sessionId = newId('session');
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

    // The row is written before the cookie is signed: a cookie whose session
    // row does not exist must never be issued, because verify() would reject it.
    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.userId,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        expiresAt,
      },
    });

    const token = await this.jwt.signAsync(
      { sub: user.userId, email: user.email, sid: sessionId } satisfies SessionClaims,
      { expiresIn: SESSION_TTL_SECONDS },
    );
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(SESSION_TTL_SECONDS * 1000));
    return sessionId;
  }

  clear(res: Response): void {
    // Overwrite then expire, so intermediaries cannot resurrect the old value.
    res.clearCookie(SESSION_COOKIE, { ...this.cookieOptions(0), maxAge: undefined });
  }

  /**
   * Signature valid, session row still live, AND the account behind it still
   * usable. Returns null for every failure - forged, expired, revoked, unknown
   * and disabled are one outcome to the caller.
   *
   * The account check is here rather than in each caller (FIX 4). Verification
   * used to stop at signature + session row, so an admin setting
   * `users.disabled_at` did not end anything: the JWT kept passing for up to
   * seven days. It happened not to be exploitable while the only guarded route
   * re-checked `disabledAt` downstream, but SessionGuard is exported for other
   * modules to mount, and the first one that trusted it alone would have handed
   * a disabled user a week of access. It is nearly free: the `sessions` row is
   * already being read, so the user status rides along on the same query.
   */
  async verify(token: string): Promise<SessionUser | null> {
    let claims: SessionClaims;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token);
    } catch {
      return null;
    }
    if (!claims.sub || !claims.email || !claims.sid) return null;

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      include: { user: { select: { disabledAt: true } } },
    });
    if (!session) return null;
    if (session.userId !== claims.sub) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    // `user` is a required FK, so a missing row means the account was deleted
    // out from under the session; treat it exactly like a disabled one.
    if (!session.user || session.user.disabledAt !== null) return null;

    return { userId: claims.sub, email: claims.email, sessionId: claims.sid };
  }

  /** Idempotent: revoking an already-revoked or unknown session is a no-op. */
  async revoke(sessionId: string, reason: SessionRevocationReason): Promise<void> {
    try {
      await this.prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    } catch (err) {
      // A failed revocation must be loud, but it must not turn logout into a
      // 500 - the cookie is cleared either way.
      this.logger.error(
        `Failed to revoke session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  /** "Sign out everywhere". Used after a password reset. */
  async revokeAllForUser(userId: string, reason: SessionRevocationReason): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }
}
