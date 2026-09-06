import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const MAILER_PORT = Symbol('MAILER_PORT');

export interface AuthMailer {
  sendEmailVerification(email: string, rawToken: string): Promise<void>;
  sendPasswordReset(email: string, rawToken: string): Promise<void>;
  /**
   * Sent when someone tries to register an address that already has an account.
   * Registration answers 202 either way (see AuthService), so this notice is the
   * only signal that the collision happened - and it goes to the address owner,
   * who is entitled to know, rather than to the caller, who is not.
   */
  sendRegistrationAttemptNotice(email: string): Promise<void>;
}

/** APP_ENVs with no real inbox and no real users, where a stub transport is safe. */
const STUB_MAILER_ENVIRONMENTS = new Set(['development', 'test']);

/** Enough of the token to correlate two log lines; useless to anyone who steals it. */
const TOKEN_LOG_PREFIX = 6;

/**
 * Placeholder transport until a notifications module ships an SMTP/provider
 * implementation. It exists so AuthService depends on a port rather than on
 * `console.log`, and so the swap is a provider change in AuthModule.
 *
 * Two rules, both learned the hard way (FIX 5):
 *
 *  1. **Raw tokens are never printed, in any environment.** The previous version
 *     wrote `token=<raw>` to `process.stdout` under APP_ENV=development. That
 *     bypasses pino entirely, so the redaction config in app.module.ts cannot
 *     touch it: one wrong APP_ENV in a staging deploy ships full
 *     account-takeover tokens into centralised logging, paired with the address
 *     they unlock. Only a short prefix is logged now, which is enough to match
 *     "the link I was issued" against "the link that was presented" and no use
 *     to anyone who reads it. Everything goes through the Nest logger, so it
 *     inherits the app's transport and level.
 *  2. **It refuses to boot outside development/test.** The old warning text
 *     asked for a real transport but did not enforce it, so a staging or
 *     production deployment came up healthy with registration and password
 *     reset silently non-functional - users saw 202s and no mail ever arrived.
 *     Constructing this provider in staging/production now fails module init.
 *
 * For a usable local flow, point MAILER_PORT at a real transport against a local
 * catcher (Mailpit/MailHog) rather than reading tokens out of the console.
 */
@Injectable()
export class DevelopmentAuthMailer implements AuthMailer {
  private readonly logger = new Logger(DevelopmentAuthMailer.name);

  constructor(@Inject(ConfigService) config: ConfigService) {
    const appEnv = config.get<string>('APP_ENV') ?? 'development';
    if (!STUB_MAILER_ENVIRONMENTS.has(appEnv)) {
      throw new Error(
        `DevelopmentAuthMailer must not be used with APP_ENV=${appEnv}. ` +
          'It delivers nothing, so registration, email verification and password ' +
          'reset would be silently non-functional. Bind MAILER_PORT to a real ' +
          'transport before deploying outside development.',
      );
    }
  }

  async sendEmailVerification(email: string, rawToken: string): Promise<void> {
    this.emit('email_verification', email, rawToken);
  }

  async sendPasswordReset(email: string, rawToken: string): Promise<void> {
    this.emit('password_reset', email, rawToken);
  }

  async sendRegistrationAttemptNotice(email: string): Promise<void> {
    this.logger.log(`[dev-mailer] registration_attempt notice for ${email} (no token involved).`);
  }

  private emit(kind: string, email: string, rawToken: string): void {
    this.logger.log(
      `[dev-mailer] ${kind} for ${email}: token ${DevelopmentAuthMailer.fingerprint(rawToken)}. ` +
        'The full token is deliberately not logged; use a real transport to receive it.',
    );
  }

  /** `abc123…(43 chars)` - correlatable, not replayable. */
  private static fingerprint(rawToken: string): string {
    return `${rawToken.slice(0, TOKEN_LOG_PREFIX)}…(${rawToken.length} chars)`;
  }
}
