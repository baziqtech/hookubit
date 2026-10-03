import { createHash } from 'node:crypto';

/** Enough of a token to correlate two log lines; useless to anyone who steals it (FIX 5). */
const TOKEN_LOG_PREFIX = 6;

const RECIPIENT_HASH_CHARS = 12;

/**
 * What a log line says instead of the address: a stable hash of the normalised
 * address plus its domain, e.g. `9f86d081884c@example.com`. The hash lets an
 * operator group every failure for one person without learning who they are;
 * the domain says whether the failures share a receiving provider, which is
 * the usual answer to "why is mail bouncing".
 */
export function redactRecipient(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const domain = at >= 0 ? normalized.slice(at + 1) : 'unknown';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, RECIPIENT_HASH_CHARS);
  return `${digest}@${domain}`;
}

/**
 * Anything that looks like an address. Wide on purpose: this runs over text
 * written by an SMTP server we do not control, and a false positive costs a
 * few characters of an error message while a false negative puts PII in the
 * log.
 */
const ADDRESS_SHAPED = /[^\s<>@,;:"'()[\]]+@[^\s<>@,;:"'()[\]]+/g;

/** Replaces every address-shaped substring in a message a server sent us. */
export function scrubAddresses(text: string): string {
  return text.replace(ADDRESS_SHAPED, '<address redacted>');
}

/** `abc123…(43 chars)` - correlatable, not replayable. The prefix-only rule stands. */
export function fingerprintToken(rawToken: string): string {
  return `${rawToken.slice(0, TOKEN_LOG_PREFIX)}…(${rawToken.length} chars)`;
}
