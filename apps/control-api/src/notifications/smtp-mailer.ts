import { Logger } from '@nestjs/common';
import { AuthMailer } from '../auth/mailer.port';
import { InvitationInvite, InvitationMailer } from '../members/invitation-mailer.port';
import { MailKind, MailTransport } from './mail-transport';
import { fingerprintToken, redactRecipient } from './redaction';
import {
  RenderedMail,
  TemplateContext,
  alreadyMemberMail,
  buildDashboardLink,
  emailVerificationMail,
  invitationMail,
  passwordResetMail,
  registrationAttemptMail,
} from './templates';

/** The dashboard pages each link lands on. Query parameter is always `token`. */
export const DASHBOARD_PATHS = {
  verifyEmail: '/verify-email',
  resetPassword: '/reset-password',
  /**
   * Nothing in the dashboard consumes this yet - `TeamPage` only sends
   * invitations. Chosen to match the two auth pages' shape so the page that
   * redeems at `POST /v1/invitations/accept` reads `?token=` the same way.
   */
  acceptInvitation: '/accept-invitation',
} as const;

/**
 * The real transport behind both mailer ports. `AuthMailer` and
 * `InvitationMailer` stay separate interfaces with separate consumers; one
 * class satisfying both is an implementation convenience, not a merger.
 *
 * What gets logged, and what never does (FIX 5, still in force):
 *  - the kind of mail, the recipient as a stable hash plus domain, the
 *    transport's message id and a six-character token prefix - enough to
 *    answer "was the link this person is holding the one we issued";
 *  - never the address, never the raw token, never a body or a link.
 *
 * Failures are logged here with the redacted recipient and RETHROWN. The
 * callers already swallow them where the response must not change (FIX 3),
 * and they log the user id; this line adds the recipient hash and the SMTP
 * reason, which is what an operator needs at 2am.
 */
export class SmtpMailer implements AuthMailer, InvitationMailer {
  private readonly logger = new Logger(SmtpMailer.name);

  constructor(
    private readonly transport: MailTransport,
    private readonly context: TemplateContext,
  ) {}

  async sendEmailVerification(email: string, rawToken: string): Promise<void> {
    const link = this.link(DASHBOARD_PATHS.verifyEmail, rawToken);
    await this.deliver('email_verification', email, emailVerificationMail(this.context, link), rawToken);
  }

  async sendPasswordReset(email: string, rawToken: string): Promise<void> {
    const link = this.link(DASHBOARD_PATHS.resetPassword, rawToken);
    await this.deliver('password_reset', email, passwordResetMail(this.context, link), rawToken);
  }

  async sendRegistrationAttemptNotice(email: string): Promise<void> {
    await this.deliver('registration_attempt', email, registrationAttemptMail(this.context));
  }

  async sendInvitation(invite: InvitationInvite): Promise<void> {
    const link = this.link(DASHBOARD_PATHS.acceptInvitation, invite.rawToken);
    await this.deliver(
      'invitation',
      invite.email,
      invitationMail(this.context, {
        organizationName: invite.organizationName,
        invitedByEmail: invite.invitedByEmail,
        role: invite.role,
        email: invite.email,
        link,
      }),
      invite.rawToken,
    );
  }

  async sendAlreadyMemberNotice(email: string, organizationName: string): Promise<void> {
    await this.deliver('already_member', email, alreadyMemberMail(this.context, organizationName));
  }

  private link(path: string, rawToken: string): string {
    return buildDashboardLink(this.context.dashboardUrl, path, { token: rawToken });
  }

  private async deliver(
    kind: MailKind,
    to: string,
    rendered: RenderedMail,
    rawToken?: string,
  ): Promise<void> {
    const recipient = redactRecipient(to);
    const token = rawToken ? `, token ${fingerprintToken(rawToken)}` : '';
    try {
      const receipt = await this.transport.send({ kind, to, ...rendered });
      const id = receipt.messageId ? `, message id ${receipt.messageId}` : '';
      this.logger.log(`Sent ${kind} to ${recipient}${token}${id}.`);
    } catch (err) {
      this.logger.error(
        `Failed to send ${kind} to ${recipient}${token}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      throw err;
    }
  }
}
