import { Logger } from '@nestjs/common';
import { MailDeliveryError, MailTransport, OutboundMail } from './mail-transport';
import { SmtpMailer } from './smtp-mailer';

const RAW_TOKEN = 'Zm9yZ2VkLXRva2VuLXRoYXQtdW5sb2Nrcy10aGUtYWNjb3VudA';
const EMAIL = 'ada@example.com';
const DASHBOARD = 'https://app.example.com';

class RecordingTransport implements MailTransport {
  readonly sent: OutboundMail[] = [];
  failWith: Error | null = null;

  async send(mail: OutboundMail): Promise<{ messageId: string | null }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
    return { messageId: `<msg-${this.sent.length}@example.com>` };
  }
}

describe('SmtpMailer', () => {
  let transport: RecordingTransport;
  let mailer: SmtpMailer;
  let logged: string[];
  let errors: string[];

  beforeEach(() => {
    transport = new RecordingTransport();
    mailer = new SmtpMailer(transport, { productName: 'Hookubit', dashboardUrl: DASHBOARD });
    logged = [];
    errors = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => jest.restoreAllMocks());

  const only = (): OutboundMail => {
    expect(transport.sent).toHaveLength(1);
    return transport.sent[0];
  };

  it('email verification links to /verify-email?token=<raw> - the page the dashboard is adding', async () => {
    await mailer.sendEmailVerification(EMAIL, RAW_TOKEN);
    const mail = only();
    expect(mail.kind).toBe('email_verification');
    expect(mail.to).toBe(EMAIL);
    expect(mail.text).toContain(`${DASHBOARD}/verify-email?token=${RAW_TOKEN}`);
    expect(mail.html).toContain(`href="${DASHBOARD}/verify-email?token=${RAW_TOKEN}"`);
  });

  it('password reset links to /reset-password?token=<raw> - what ResetPasswordPage reads', async () => {
    await mailer.sendPasswordReset(EMAIL, RAW_TOKEN);
    const mail = only();
    expect(mail.kind).toBe('password_reset');
    expect(mail.text).toContain(`${DASHBOARD}/reset-password?token=${RAW_TOKEN}`);
  });

  it('invitation links to /accept-invitation?token=<raw>', async () => {
    await mailer.sendInvitation({
      email: EMAIL,
      organizationName: 'Acme',
      invitedByEmail: 'owner@acme.example',
      role: 'developer',
      rawToken: RAW_TOKEN,
    });
    const mail = only();
    expect(mail.kind).toBe('invitation');
    expect(mail.text).toContain(`${DASHBOARD}/accept-invitation?token=${RAW_TOKEN}`);
    expect(mail.subject).toContain('owner@acme.example invited you to Acme');
  });

  it('the two notices carry no token', async () => {
    await mailer.sendRegistrationAttemptNotice(EMAIL);
    await mailer.sendAlreadyMemberNotice(EMAIL, 'Acme');
    expect(transport.sent.map((m) => m.kind)).toEqual(['registration_attempt', 'already_member']);
    for (const mail of transport.sent) {
      expect(mail.text).not.toContain('token=');
      expect(mail.html).not.toContain('token=');
    }
  });

  it('REGRESSION (FIX 5): logs a token prefix and a hashed recipient - never the token, address, body or link', async () => {
    await mailer.sendEmailVerification(EMAIL, RAW_TOKEN);
    await mailer.sendInvitation({
      email: EMAIL,
      organizationName: 'Acme',
      invitedByEmail: 'owner@acme.example',
      role: 'developer',
      rawToken: RAW_TOKEN,
    });

    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line).toContain(RAW_TOKEN.slice(0, 6));
      expect(line).not.toContain(RAW_TOKEN.slice(0, 12));
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain('ada');
      expect(line).not.toContain('token=');
      expect(line).not.toContain(DASHBOARD);
      expect(line).toMatch(/[0-9a-f]{12}@example\.com/);
      expect(line).toContain('message id <msg-');
    }
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it('logs a failure with the redacted recipient and RETHROWS so the caller keeps its FIX 3 decision', async () => {
    transport.failWith = new MailDeliveryError(
      'password_reset',
      'SMTP delivery via smtp://mail:587 failed: 550 <address redacted>: user unknown',
      'EENVELOPE',
    );

    await expect(mailer.sendPasswordReset(EMAIL, RAW_TOKEN)).rejects.toBeInstanceOf(
      MailDeliveryError,
    );

    expect(logged).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Failed to send password_reset');
    expect(errors[0]).toContain('user unknown');
    expect(errors[0]).toContain(RAW_TOKEN.slice(0, 6));
    expect(errors[0]).not.toContain(RAW_TOKEN.slice(0, 12));
    expect(errors[0]).not.toContain(EMAIL);
    expect(errors[0]).toMatch(/[0-9a-f]{12}@example\.com/);
  });
});
