import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { MailDeliveryError, MailReceipt, MailTransport, OutboundMail } from './mail-transport';
import { scrubAddresses } from './redaction';

/**
 * nodemailer's defaults are 2 minutes to connect, 30 seconds for the greeting
 * and 10 minutes of socket idle. Every send here is awaited on a request path
 * (`register` awaits its verification mail after the commit), so a dead SMTP
 * host with those defaults is a two-minute registration request. These are
 * fixed rather than configurable: there is no deployment where a slower SMTP
 * server should make signup slower.
 */
export const SMTP_TIMEOUTS_MS = {
  connection: 5_000,
  greeting: 5_000,
  socket: 15_000,
} as const;

/**
 * The SMTP transport. One instance per process, shared by both mailer ports
 * through `NotificationsModule`.
 *
 * `SMTP_URL` is handed to nodemailer as a connection URL, so `smtp://` and
 * `smtps://`, credentials, and nodemailer's query-string options
 * (`?pool=true`, `?ignoreTLS=true`) all work without a parser of our own. The
 * URL is never logged - it carries the password - only its `scheme//host:port`.
 *
 * Boot verification is a WARNING, not a refusal. Configuration mistakes
 * (`SMTP_URL` unset in production, a malformed `MAIL_FROM`) are refused by
 * `env.schema.ts` before this class exists; an SMTP server that is down at boot
 * is an operational fault, and the control plane going with it would take the
 * operator surface down over a mail outage.
 */
export class NodemailerSmtpTransport
  implements MailTransport, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(NodemailerSmtpTransport.name);
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;
  /** `smtp://host:port` - the URL with its credentials removed, for log lines. */
  private readonly target: string;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.target = describeTarget(smtpUrl);
    this.transporter = createTransport({
      url: smtpUrl,
      connectionTimeout: SMTP_TIMEOUTS_MS.connection,
      greetingTimeout: SMTP_TIMEOUTS_MS.greeting,
      socketTimeout: SMTP_TIMEOUTS_MS.socket,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.transporter.verify();
      this.logger.log(`SMTP transport ready at ${this.target}.`);
    } catch (err) {
      this.logger.warn(
        `SMTP transport at ${this.target} could not be verified at boot: ${scrubAddresses(reason(err))}. ` +
          'Every send will still be attempted; check SMTP_URL and the server.',
      );
    }
  }

  onApplicationShutdown(): void {
    this.transporter.close();
  }

  async send(mail: OutboundMail): Promise<MailReceipt> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        // The object form, so the address is never parsed as a header list.
        to: { name: '', address: mail.to },
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // RFC 3834: tells auto-responders not to answer.
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      return { messageId: info.messageId ?? null };
    } catch (err) {
      throw new MailDeliveryError(
        mail.kind,
        `SMTP delivery via ${this.target} failed: ${scrubAddresses(reason(err))}`,
        errorCode(err),
      );
    }
  }
}

function describeTarget(smtpUrl: string): string {
  try {
    const url = new URL(smtpUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'smtp';
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
