import { TOKEN_TTL_MS } from '../auth/token.service';

/**
 * The four-and-a-bit messages the control plane sends, as plain text with an
 * HTML alternative. Pure functions: no template engine, no I/O, nothing to
 * mock. Every interpolated value that did not come from this process -
 * organization names, the inviter's address, a role - is HTML-escaped on the
 * way into the HTML part and whitespace-collapsed on the way into a subject.
 *
 * Lifetimes are read from `TOKEN_TTL_MS` rather than typed here, so the mail
 * cannot promise "24 hours" after someone shortens the token.
 */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateContext {
  /** What the reader knows the service as. Derived from MAIL_FROM's display name. */
  productName: string;
  /** Base for every link; `DASHBOARD_URL`. */
  dashboardUrl: string;
}

export interface InvitationTemplateInput {
  organizationName: string;
  invitedByEmail: string;
  role: string;
  /** The recipient's own address, repeated so they accept with the right account. */
  email: string;
  link: string;
}

/**
 * Joins a dashboard base and a page path without losing a base path segment
 * (`https://example.com/dash` + `/verify-email` keeps `/dash`) and without a
 * doubled slash. Query parameters are set through `URLSearchParams`, so a token
 * is percent-encoded rather than concatenated.
 */
export function buildDashboardLink(
  dashboardUrl: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(dashboardUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  url.search = '';
  url.hash = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function emailVerificationMail(ctx: TemplateContext, link: string): RenderedMail {
  const lifetime = describeDuration(TOKEN_TTL_MS.email_verification);
  return render(ctx, {
    subject: `Confirm your email address for ${ctx.productName}`,
    title: 'Confirm your email address',
    paragraphs: [
      `Confirm this address to finish setting up your ${ctx.productName} account.`,
      `The link works once and expires in ${lifetime}. If it has expired, sign in and request a new one.`,
      'If you did not create this account, ignore this email - nothing happens until the address is confirmed.',
    ],
    action: { label: 'Confirm email address', link },
  });
}

export function passwordResetMail(ctx: TemplateContext, link: string): RenderedMail {
  const lifetime = describeDuration(TOKEN_TTL_MS.password_reset);
  return render(ctx, {
    subject: `Reset your ${ctx.productName} password`,
    title: 'Reset your password',
    paragraphs: [
      `Someone asked to reset the password for your ${ctx.productName} account. Use the link below to choose a new one.`,
      `The link works once and expires in ${lifetime}. Requesting another link cancels this one.`,
      'If you did not ask for this, ignore this email. Your password has not changed.',
    ],
    action: { label: 'Choose a new password', link },
  });
}

/** No token, by design (see `AuthMailer.sendRegistrationAttemptNotice`). */
export function registrationAttemptMail(ctx: TemplateContext): RenderedMail {
  const signIn = buildDashboardLink(ctx.dashboardUrl, '/login');
  const forgot = buildDashboardLink(ctx.dashboardUrl, '/forgot-password');
  return render(ctx, {
    subject: `Someone tried to sign up for ${ctx.productName} with your email`,
    title: 'This address already has an account',
    paragraphs: [
      `Someone just tried to create a ${ctx.productName} account with this email address, but it already has one. Nothing has changed.`,
      `If that was you, sign in instead: ${signIn}`,
      `If you have forgotten your password, reset it here: ${forgot}`,
      'If it was not you, no action is needed.',
    ],
  });
}

export function invitationMail(ctx: TemplateContext, input: InvitationTemplateInput): RenderedMail {
  const lifetime = describeDuration(TOKEN_TTL_MS.invitation);
  const organization = oneLine(input.organizationName);
  const inviter = oneLine(input.invitedByEmail);
  const role = oneLine(input.role);
  return render(ctx, {
    subject: `${inviter} invited you to ${organization} on ${ctx.productName}`,
    title: `You have been invited to ${organization}`,
    paragraphs: [
      `${inviter} has invited you to join ${organization} on ${ctx.productName} as ${role}.`,
      `Accept the invitation while signed in as ${input.email}. If you do not have a ${ctx.productName} account yet, create one with this exact address first, confirm it, then open the link.`,
      `The invitation works once and expires in ${lifetime}.`,
      'If you were not expecting this, ignore this email and nothing will change.',
    ],
    action: { label: 'Accept invitation', link: input.link },
  });
}

/** No token, by design (see `InvitationMailer.sendAlreadyMemberNotice`). */
export function alreadyMemberMail(ctx: TemplateContext, organizationName: string): RenderedMail {
  const organization = oneLine(organizationName);
  const dashboard = buildDashboardLink(ctx.dashboardUrl, '/');
  return render(ctx, {
    subject: `You are already a member of ${organization}`,
    title: `You are already a member of ${organization}`,
    paragraphs: [
      `Someone tried to invite this address to ${organization} on ${ctx.productName}, but you are already a member. Nothing has changed.`,
      `You can open the organization here: ${dashboard}`,
    ],
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface MailSpec {
  subject: string;
  title: string;
  paragraphs: string[];
  action?: { label: string; link: string };
}

function render(ctx: TemplateContext, spec: MailSpec): RenderedMail {
  const subject = oneLine(spec.subject);
  const footer = `You are receiving this because of activity on a ${ctx.productName} account with this email address.`;

  const textParts = [spec.title, '', ...spec.paragraphs.flatMap((p) => [p, ''])];
  if (spec.action) textParts.push(`${spec.action.label}:`, spec.action.link, '');
  textParts.push('--', footer);

  const paragraphsHtml = spec.paragraphs
    .map((p) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(p)}</p>`)
    .join('\n');
  const actionHtml = spec.action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(spec.action.link)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1f2937;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(spec.action.label)}</a></p>\n` +
      `<p style="margin:0 0 14px;font-size:13px;color:#6b7280;word-break:break-all">If the button does not work, copy this link into your browser:<br>${escapeHtml(spec.action.link)}</p>`
    : '';

  const html = [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#111827">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px">',
    `<h1 style="margin:0 0 18px;font-size:20px">${escapeHtml(spec.title)}</h1>`,
    paragraphsHtml,
    actionHtml,
    `<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">${escapeHtml(footer)}</p>`,
    '</div></body></html>',
  ].join('\n');

  return { subject, text: textParts.join('\n'), html };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Collapses whitespace, including newlines - a header field is one line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Whole days, else whole hours, else minutes - never rounded up to a unit the token does not last. */
export function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

/* ── Operational notifications ────────────────────────────────────────────── */

/**
 * "Somebody added this address to a project. Do you want it?"
 *
 * Sent before an address receives anything else, ever. A group address exists
 * precisely so one person can put everybody else on it, and without this step
 * adding `oncall@` to a project would be a way to mail a team forever with no
 * one on it having agreed.
 *
 * The mail names the project, because the reader is being asked to agree to
 * something and "a HookuBit project" is not enough to decide on.
 */
export function notificationConfirmationMail(
  ctx: TemplateContext,
  input: { projectName: string; link: string },
): RenderedMail {
  return render(ctx, {
    subject: `Confirm alerts for ${input.projectName}`,
    title: 'Confirm this address for alerts',
    paragraphs: [
      `Someone added this address to receive operational alerts for the ${input.projectName} project on ${ctx.productName}.`,
      'Until you confirm, this address receives nothing at all. If you were not expecting this, ignore it — nothing will be sent.',
    ],
    action: { label: 'Confirm this address', link: input.link },
  });
}

export interface NotificationAlertInput {
  projectName: string;
  /** One line. What happened. */
  headline: string;
  /** Two or three sentences. What it means and what to do. */
  body: string;
  /** Where to go and look. */
  link: string;
  /** How many times this happened inside the grouping window. */
  occurrences: number;
}

/**
 * An operational alert.
 *
 * `occurrences` is stated when it is above one, because the grouping rule means
 * a single message can stand for a dozen failures — and a reader who thinks it
 * stands for one will conclude the problem is smaller than it is.
 */
export function notificationAlertMail(
  ctx: TemplateContext,
  input: NotificationAlertInput,
): RenderedMail {
  const repeated =
    input.occurrences > 1
      ? [`This has happened ${input.occurrences} times in the last half hour. This is one message for all of them.`]
      : [];

  return render(ctx, {
    subject: `[${input.projectName}] ${input.headline}`,
    title: input.headline,
    paragraphs: [input.body, ...repeated],
    action: { label: 'Open in ' + ctx.productName, link: input.link },
  });
}
