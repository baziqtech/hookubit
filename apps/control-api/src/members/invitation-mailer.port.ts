import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const INVITATION_MAILER = Symbol('INVITATION_MAILER');

export interface InvitationInvite {
  email: string;
  organizationName: string;
  invitedByEmail: string;
  role: string;
  /** Shown to the invitee exactly once, by mail. Never persisted, never logged. */
  rawToken: string;
}

/**
 * Outbound mail for membership invitations.
 *
 * A separate port from `AuthMailer` rather than three more methods on it:
 * `AuthModule` does not export `MAILER_PORT`, this module is not allowed to
 * edit it, and the two have genuinely different audiences — one talks to a
 * person about their own credentials, the other talks to a person about
 * somebody else's organization.
 *
 * `sendAlreadyMemberNotice` is not a courtesy. `MembersService.invite` answers
 * identically whether the address belongs to an existing member, an existing
 * user, or nobody at all, so the address owner is the only party who can be
 * told anything — and they are entitled to know that someone tried to add them
 * to an organization they are already in. Same posture as
 * `AuthMailer.sendRegistrationAttemptNotice`.
 */
export interface InvitationMailer {
  sendInvitation(invite: InvitationInvite): Promise<void>;
  sendAlreadyMemberNotice(email: string, organizationName: string): Promise<void>;
}

/** APP_ENVs with no real inbox and no real users, where a stub transport is safe. */
const STUB_MAILER_ENVIRONMENTS = new Set(['development', 'test']);

/** Enough of the token to correlate two log lines; useless to anyone who steals it. */
const TOKEN_LOG_PREFIX = 6;

/**
 * The transport bound when `SMTP_URL` is unset; the real one is
 * `notifications/SmtpMailer`, chosen by `selectMailer` in `MembersModule`.
 * The two rules `DevelopmentAuthMailer` learned the hard way (HANDOFF, FIX 5)
 * apply verbatim:
 *
 *  1. **Raw tokens are never printed, in any environment.** An invitation token
 *     grants membership of somebody else's organization; printed to stdout it
 *     bypasses pino's redaction and lands in centralised logging next to the
 *     address it was issued for.
 *  2. **It refuses to boot outside development/test.** A staging deploy that
 *     came up healthy with invitations silently undelivered would look exactly
 *     like a working system to everyone except the people who never got mail.
 */
@Injectable()
export class DevelopmentInvitationMailer implements InvitationMailer {
  private readonly logger = new Logger(DevelopmentInvitationMailer.name);

  constructor(@Inject(ConfigService) config: ConfigService) {
    const appEnv = config.get<string>('APP_ENV') ?? 'development';
    if (!STUB_MAILER_ENVIRONMENTS.has(appEnv)) {
      throw new Error(
        `DevelopmentInvitationMailer must not be used with APP_ENV=${appEnv}. ` +
          'It delivers nothing, so member invitations would be silently ' +
          'non-functional. Bind INVITATION_MAILER to a real transport before ' +
          'deploying outside development.',
      );
    }
  }

  async sendInvitation(invite: InvitationInvite): Promise<void> {
    this.logger.log(
      `[dev-mailer] invitation for ${invite.email} to "${invite.organizationName}" as ` +
        `${invite.role}: token ${DevelopmentInvitationMailer.fingerprint(invite.rawToken)}. ` +
        'The full token is deliberately not logged; use a real transport to receive it.',
    );
  }

  async sendAlreadyMemberNotice(email: string, organizationName: string): Promise<void> {
    this.logger.log(
      `[dev-mailer] already-a-member notice for ${email} regarding "${organizationName}" ` +
        '(no token involved).',
    );
  }

  /** `abc123…(43 chars)` - correlatable, not replayable. */
  private static fingerprint(rawToken: string): string {
    return `${rawToken.slice(0, TOKEN_LOG_PREFIX)}…(${rawToken.length} chars)`;
  }
}
