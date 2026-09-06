import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, User } from '@prisma/client';
import { Response } from 'express';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AuthUserDto, LoginDto, RegisterDto, ResetPasswordDto, VerifyEmailDto } from './dto';
import { AuthMailer, MAILER_PORT } from './mailer.port';
import { PasswordService } from './password.service';
import { SessionService, SessionUser } from './session.service';
import { TokenService } from './token.service';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

const UNIQUE_VIOLATION = 'P2002';

/**
 * Which unique index a P2002 came from. `unknown` means the error was a unique
 * violation from some index we do not handle here - it must surface, not be
 * mislabelled as one we do.
 */
type UniqueTarget = 'user_email' | 'organization_slug' | 'unknown' | null;

/**
 * Registration re-runs the whole transaction when it loses a slug race. Five
 * attempts: the first uses the bare slug, the rest a fresh random suffix, so the
 * chance of exhausting them is negligible.
 */
const MAX_REGISTRATION_ATTEMPTS = 5;

/**
 * Authentication (ARCHITECTURE.md 9).
 *
 * Three rules drive everything here:
 *  1. No response distinguishes "no such account" from "wrong credentials", and
 *     none reveals whether an address is registered. That now includes
 *     registration itself: POST /v1/auth/register answers 202 with no body and
 *     no session cookie whether the address was free or already taken (FIX 2).
 *     It used to answer 201 for a free address and 409 for a taken one, which
 *     let an attacker walk a list of addresses and contradicted this very
 *     docblock.
 *     The one deliberate exception is `email_not_verified` on login, which is
 *     raised only after the password has already been verified (FIX 5).
 *  2. Password and reset tokens exist only in memory and in the request body;
 *     they are never logged, never returned and never stored in the clear.
 *  3. Registration is a single transaction - a user without an organization and
 *     an owner membership is not a half-signup, it is a broken account.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    @Inject(MAILER_PORT) private readonly mailer: AuthMailer,
  ) {}

  private get openRegistrationAllowed(): boolean {
    // env.schema already coerced the string to a boolean.
    return this.config.get<boolean>('ALLOW_OPEN_REGISTRATION') === true;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Enumeration-safe by construction: every outcome except "registration is
   * switched off" returns the same empty 202 (FIX 2). Nothing about the response
   * - status, body, headers, or the presence of a session cookie - differs
   * between a free address and a taken one, so there is no session issued here
   * either; the user verifies their address and logs in.
   *
   * The password is hashed before the collision is known, so the argon2 cost is
   * paid on both paths and the timing does not leak either.
   */
  async register(dto: RegisterDto, ctx: RequestContext = {}): Promise<void> {
    if (!this.openRegistrationAllowed) {
      throw new AppError(
        'forbidden',
        'Self-serve registration is disabled. Ask an organization owner for an invitation.',
      );
    }

    const email = AuthService.normalizeEmail(dto.email);
    const passwordHash = await this.passwords.hash(dto.password);
    const orgName = dto.organization_name?.trim() || AuthService.defaultOrgName(email);

    let user: User | null = null;

    // Retried, because `uniqueSlug` cannot be trusted on its own (FIX 1). Its
    // SELECT runs inside the transaction, and under READ COMMITTED it cannot
    // see a concurrent, uncommitted `organizations` row - so two people signing
    // up as info@acme.com and info@globex.com both derive the slug "info", both
    // pass the check, and the second INSERT blocks and then raises P2002. The
    // database is the only authority on uniqueness here; the SELECT is just an
    // optimisation that keeps the common case on the bare slug.
    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
      try {
        user = await this.createAccount({ email, passwordHash, orgName, name: dto.name, ctx }, attempt);
        break;
      } catch (err) {
        const target = AuthService.uniqueViolationTarget(err);

        // Lost the slug race. Nothing was committed; go again with a fresh
        // suffix. This used to be reported as "An account with that email
        // already exists" - a false message, on a request that would have
        // succeeded on a retry the caller was never told to make.
        if (target === 'organization_slug') continue;

        if (target === 'user_email') {
          await this.notifyRegistrationAttempt(email);
          return;
        }

        // Including 'unknown': a P2002 from an index we do not model must not be
        // laundered into a friendly message.
        throw err;
      }
    }

    if (!user) {
      throw new AppError(
        'conflict',
        'Could not allocate an organization slug. Try a different organization name.',
      );
    }

    // Issued after commit: a mail failure must not undo a valid signup, and
    // `sendVerification` swallows transport errors for the same reason (FIX 3).
    // The user can always request a fresh link.
    await this.sendVerification(user);
  }

  /** One attempt at the registration transaction. Slug suffixing is forced after the first. */
  private async createAccount(
    input: {
      email: string;
      passwordHash: string;
      orgName: string;
      name?: string;
      ctx: RequestContext;
    },
    attempt: number,
  ): Promise<User> {
    const { email, passwordHash, orgName, ctx } = input;

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const organization = await tx.organization.create({
        data: {
          id: newId('organization'),
          name: orgName,
          slug: await AuthService.uniqueSlug(tx, orgName, attempt > 0),
        },
      });

      const created = await tx.user.create({
        data: { id: newId('user'), email, name: input.name ?? null, passwordHash },
      });

      await tx.organizationMember.create({
        data: {
          id: newId('member'),
          organizationId: organization.id,
          userId: created.id,
          role: 'owner',
        },
      });

      await tx.auditLog.create({
        data: {
          id: newId('auditLog'),
          organizationId: organization.id,
          userId: created.id,
          action: 'user.registered',
          resourceType: 'user',
          resourceId: created.id,
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });

      return created;
    });
  }

  // -------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------

  async login(dto: LoginDto, res: Response, ctx: RequestContext = {}): Promise<AuthUserDto> {
    const email = AuthService.normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Burn comparable CPU so timing does not enumerate accounts.
      await this.passwords.dummyVerify();
      throw AuthService.invalidCredentials();
    }
    if (user.disabledAt) {
      await this.passwords.dummyVerify();
      throw AuthService.invalidCredentials();
    }
    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      throw AuthService.invalidCredentials();
    }

    // Only AFTER the password check (FIX 5). Registration is enumeration-safe
    // and self-serve signup only requires an address to be typed, not owned, so
    // an unverified account was a usable organization belonging to whoever
    // guessed the address. Checking here rather than before the password keeps
    // the response non-enumerating: reaching this branch already requires the
    // correct password, so the caller learns nothing new about the address.
    if (!user.emailVerifiedAt) {
      throw new AppError(
        'email_not_verified',
        'Confirm your email address before signing in. Request a new link if the last one expired.',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit(user.id, 'user.login', ctx);
    await this.sessions.issue(res, { userId: user.id, email: user.email }, ctx);
    return AuthService.toDto(user);
  }

  /**
   * Idempotent: clearing a cookie that was already absent or invalid is a
   * success, not a 401. `sessionCookie` is the raw cookie value, verified here
   * rather than in the controller.
   *
   * The session row is REVOKED, not merely un-cookied. Clearing the cookie only
   * affects the browser doing the logging out; a token already copied elsewhere
   * stayed valid until expiry, which made logout advisory. Revoke first, then
   * clear, so a failure between the two leaves the session dead rather than
   * alive-but-invisible.
   */
  async logout(
    res: Response,
    sessionCookie: string | null,
    ctx: RequestContext = {},
  ): Promise<void> {
    const session = sessionCookie ? await this.sessions.verify(sessionCookie) : null;
    if (session) {
      await this.sessions.revoke(session.sessionId, 'logout');
      await this.audit(session.userId, 'user.logout', ctx);
    }
    this.sessions.clear(res);
  }

  // -------------------------------------------------------------------------
  // Email verification
  // -------------------------------------------------------------------------

  async verifyEmail(dto: VerifyEmailDto): Promise<AuthUserDto> {
    const record = await this.tokens.consume(dto.token, 'email_verification');
    if (!record) {
      // Unknown, already consumed and expired are one outcome by design.
      throw new AppError('invalid_request', 'This verification link is invalid or has expired.');
    }

    const user = record.userId
      ? await this.prisma.user.findUnique({ where: { id: record.userId } })
      : await this.prisma.user.findUnique({ where: { email: record.email } });
    if (!user) {
      throw new AppError('invalid_request', 'This verification link is invalid or has expired.');
    }

    const verified = user.emailVerifiedAt
      ? user
      : await this.prisma.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: new Date() },
        });

    await this.audit(verified.id, 'user.email_verified', {});
    return AuthService.toDto(verified);
  }

  /** Idempotent from the caller's point of view; never reveals whether the address exists. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: AuthService.normalizeEmail(email) },
    });
    if (user && !user.emailVerifiedAt && !user.disabledAt) {
      await this.tokens.revokeOutstanding(user.email, 'email_verification');
      await this.sendVerification(user);
    }
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  async forgotPassword(email: string): Promise<void> {
    const normalized = AuthService.normalizeEmail(email);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    // Silent no-op for unknown or disabled accounts. The caller gets the same
    // 202 either way.
    if (!user || user.disabledAt) return;

    // Everything past this point is best-effort (FIX 3). An unknown address
    // returns above with 202; if a mailer failure escaped from here, a degraded
    // SMTP transport would answer 202 for unregistered addresses and 500 for
    // registered ones - an enumeration oracle that defeats every other uniform
    // response in this class. The failure is logged (never the token, never the
    // address) and the caller still gets 202.
    try {
      // Requesting a new link invalidates the previous one.
      await this.tokens.revokeOutstanding(user.email, 'password_reset');
      const issued = await this.tokens.issue({
        type: 'password_reset',
        email: user.email,
        userId: user.id,
      });
      await this.mailer.sendPasswordReset(user.email, issued.raw);
    } catch (err) {
      this.logger.error(
        `Failed to deliver password reset for user ${user.id}: ${AuthService.reason(err)}`,
      );
    }
  }

  async resetPassword(dto: ResetPasswordDto, res: Response, ctx: RequestContext = {}): Promise<void> {
    const record = await this.tokens.consume(dto.token, 'password_reset');
    if (!record) {
      throw new AppError('invalid_request', 'This reset link is invalid or has expired.');
    }

    const user = record.userId
      ? await this.prisma.user.findUnique({ where: { id: record.userId } })
      : await this.prisma.user.findUnique({ where: { email: record.email } });
    if (!user || user.disabledAt) {
      throw new AppError('invalid_request', 'This reset link is invalid or has expired.');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Any other outstanding reset link is now dead.
    await this.tokens.revokeOutstanding(user.email, 'password_reset');

    // Sign out everywhere. A reset is the response to a suspected compromise,
    // so every session the attacker may hold has to die with the old password -
    // clearing this response's cookie alone would leave them logged in.
    await this.sessions.revokeAllForUser(user.id, 'password_reset');
    await this.audit(user.id, 'user.password_reset', ctx);

    // Force a fresh login rather than silently keeping the current session.
    this.sessions.clear(res);
  }

  // -------------------------------------------------------------------------
  // Session introspection
  // -------------------------------------------------------------------------

  async currentUser(session: SessionUser): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.disabledAt) {
      throw new AppError('unauthenticated', 'Session is no longer valid.');
    }
    return AuthService.toDto(user);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Best-effort by design (FIX 3). In `register` this runs after the
   * transaction has committed: if it threw, the caller would get a 500 for an
   * account that exists, retry, and be told the address is taken - with no
   * session and no verification mail ever sent. A signup is not undone by SMTP
   * being down; the user requests a fresh link.
   *
   * The token is never included in the log line - that is the whole point of
   * mailing it.
   */
  private async sendVerification(user: User): Promise<void> {
    try {
      const issued = await this.tokens.issue({
        type: 'email_verification',
        email: user.email,
        userId: user.id,
      });
      await this.mailer.sendEmailVerification(user.email, issued.raw);
    } catch (err) {
      this.logger.error(
        `Failed to deliver email verification for user ${user.id}: ${AuthService.reason(err)}`,
      );
    }
  }

  /**
   * Tells the address owner that someone tried to sign up with it. Registration
   * cannot tell the *caller* that the address is taken (FIX 2), but the person
   * who owns it is entitled to know, and it is the only signal that would
   * otherwise be lost. Best-effort, for the same reason as everything else here.
   */
  private async notifyRegistrationAttempt(email: string): Promise<void> {
    try {
      await this.mailer.sendRegistrationAttemptNotice(email);
    } catch (err) {
      this.logger.error(
        `Failed to deliver a registration-attempt notice: ${AuthService.reason(err)}`,
      );
    }
  }

  /**
   * Audit logs are org-scoped (`audit_logs.organization_id` is NOT NULL), so an
   * account with no membership yet simply produces no row. Never fail the
   * request because auditing failed.
   */
  private async audit(userId: string, action: string, ctx: RequestContext): Promise<void> {
    try {
      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (!membership) return;

      await this.prisma.auditLog.create({
        data: {
          id: newId('auditLog'),
          organizationId: membership.organizationId,
          userId,
          action,
          resourceType: 'user',
          resourceId: userId,
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to write audit log for ${action}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Which index a P2002 came from (FIX 1).
   *
   * The old version duck-typed on the error code alone and assumed every unique
   * violation in `register` was `users.email`. Registration writes two unique
   * columns, and the other one - `organizations.slug` - collides routinely,
   * because the default org name is the local part of the address:
   * info@acme.com and info@globex.com both slugify to "info". The caller was
   * told "an account with that email already exists", which was false, hid a
   * retryable condition, and lost the signup.
   *
   * Still duck-typed rather than `instanceof PrismaClientKnownRequestError`: the
   * error crosses a module boundary and a duplicated @prisma/client in the
   * dependency tree would silently break an instanceof check.
   *
   * `meta.target` is a column list on PostgreSQL (`["email"]`) but a constraint
   * name on some drivers/versions (`"users_email_key"`), so both shapes are
   * matched by substring.
   */
  private static uniqueViolationTarget(err: unknown): UniqueTarget {
    if (typeof err !== 'object' || err === null || !('code' in err)) return null;
    if ((err as { code?: unknown }).code !== UNIQUE_VIOLATION) return null;

    const raw = (err as { meta?: { target?: unknown } }).meta?.target;
    const target = (
      Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
    ).toLowerCase();

    if (target.includes('slug')) return 'organization_slug';
    if (target.includes('email')) return 'user_email';
    return 'unknown';
  }

  private static reason(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown error';
  }

  private static invalidCredentials(): AppError {
    return new AppError('unauthenticated', 'Invalid email or password.');
  }

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private static defaultOrgName(email: string): string {
    return email.split('@')[0] || 'workspace';
  }

  private static slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    return slug || 'workspace';
  }

  /**
   * `organizations.slug` is globally unique; suffix until it is free.
   *
   * Advisory only - this SELECT runs inside the caller's transaction and cannot
   * see concurrent uncommitted rows, so a free-looking slug can still lose the
   * INSERT race. `register` catches that and retries with `forceSuffix`, which
   * skips the bare slug the loser already knows is contended.
   */
  private static async uniqueSlug(
    tx: Prisma.TransactionClient,
    name: string,
    forceSuffix = false,
  ): Promise<string> {
    const base = AuthService.slugify(name);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate =
        attempt === 0 && !forceSuffix ? base : `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const taken = await tx.organization.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    throw new AppError('conflict', 'Could not allocate an organization slug. Try a different name.');
  }

  private static toDto(user: User): AuthUserDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: user.emailVerifiedAt !== null,
    };
  }
}
