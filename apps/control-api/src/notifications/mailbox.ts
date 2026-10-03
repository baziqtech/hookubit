/**
 * A parsed `MAIL_FROM` value: `Name <address>` or a bare `address`.
 *
 * Kept dependency-free on purpose - `config/env.schema.ts` imports it to
 * validate the variable at boot, and the templates import it to derive the
 * product name shown to the reader, so it must sit below both.
 */
export interface Mailbox {
  /** The display name, or null for a bare address. */
  name: string | null;
  address: string;
}

/**
 * One `@`, no whitespace, no angle brackets, no list separators. Deliberately
 * not a full RFC 5322 grammar: this validates an operator's own sender
 * address, not untrusted input, and `no-reply@localhost` (no dot) must pass
 * for a local catcher.
 */
const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

const NAMED = /^(.*?)\s*<([^<>]+)>$/;

export function parseMailbox(value: string): Mailbox | null {
  const trimmed = value.trim();
  const named = NAMED.exec(trimmed);
  if (named) {
    const address = named[2].trim();
    if (!ADDRESS.test(address)) return null;
    const name = named[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { name: name || null, address };
  }
  return ADDRESS.test(trimmed) ? { name: null, address: trimmed } : null;
}
