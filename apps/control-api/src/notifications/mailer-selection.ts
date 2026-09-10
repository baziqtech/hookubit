import { ConfigService } from '@nestjs/config';
import { MailTransport } from './mail-transport';
import { parseMailbox } from './mailbox';
import { NodemailerSmtpTransport } from './smtp-transport';
import { TemplateContext } from './templates';

/** APP_ENVs with no real inbox and no real users, where a logging stub is safe. */
export const STUB_MAILER_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);

const DEFAULT_DASHBOARD_URL = 'http://localhost:5173';

export interface MailerChoices<T> {
  /** Built when `SMTP_URL` is set - in EVERY environment, development included. */
  smtp: (transport: MailTransport, context: TemplateContext) => T;
  /** Built when it is not, and only where a stub is allowed to exist. */
  stub: () => T;
}

/**
 * The selection rule, shared by `AuthModule` and `MembersModule`:
 *
 *  - `SMTP_URL` set: the SMTP transport, whatever `APP_ENV` says. A developer
 *    pointing at Mailpit and a production deploy pointing at a provider are the
 *    same code path.
 *  - `SMTP_URL` unset: the caller's development stub, which is refused outside
 *    development/test - and refused HERE, by name, before the stub's own
 *    constructor gets a second chance to say the same thing. `env.schema.ts`
 *    refuses the combination earlier still; this is the guard for a
 *    `ConfigService` that did not come through the schema.
 */
export function selectMailer<T>(
  config: ConfigService,
  transport: MailTransport | null,
  choices: MailerChoices<T>,
): T {
  if (transport) return choices.smtp(transport, templateContextFrom(config));

  const appEnv = config.get<string>('APP_ENV') ?? 'development';
  if (!STUB_MAILER_ENVIRONMENTS.has(appEnv)) {
    throw new Error(
      `SMTP_URL is not set and APP_ENV=${appEnv}. There is no stub transport outside ` +
        'development/test: set SMTP_URL (and MAIL_FROM), or registration, email verification, ' +
        'password reset and member invitations will silently deliver nothing.',
    );
  }
  return choices.stub();
}

/**
 * `MAIL_TRANSPORT`'s factory. Null when `SMTP_URL` is unset, so the choice
 * above is made on the presence of a transport rather than by re-reading the
 * variable in two modules.
 */
export function createMailTransport(config: ConfigService): MailTransport | null {
  const smtpUrl = config.get<string>('SMTP_URL')?.trim();
  if (!smtpUrl) return null;

  const from = config.get<string>('MAIL_FROM')?.trim();
  if (!from || !parseMailbox(from)) {
    throw new Error(
      'MAIL_FROM must be set to a mailbox ("Display Name <address>") whenever SMTP_URL is set.',
    );
  }
  return new NodemailerSmtpTransport(smtpUrl, from);
}

/**
 * The product name the reader sees is `MAIL_FROM`'s display name, falling
 * back to the dashboard's host. Not a separate variable: the name on the From
 * line and the name in the body must agree, and one setting cannot disagree
 * with itself.
 */
export function templateContextFrom(config: ConfigService): TemplateContext {
  const dashboardUrl = config.get<string>('DASHBOARD_URL')?.trim() || DEFAULT_DASHBOARD_URL;
  const from = config.get<string>('MAIL_FROM');
  const mailbox = from ? parseMailbox(from) : null;
  return { dashboardUrl, productName: mailbox?.name ?? hostOf(dashboardUrl) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
