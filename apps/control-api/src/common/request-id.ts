import { randomUUID } from 'node:crypto';

/** Correlation ids are opaque handles: alphanumerics, dash, underscore, <= 64. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Request correlation id (FIX 7).
 *
 * A client-supplied `x-request-id` used to be taken verbatim as pino's `req.id`,
 * echoed in a response header and repeated in every error body. Neither
 * response splitting (Node rejects CR/LF in a header value) nor XSS
 * (`res.json` escapes) was reachable, but arbitrary attacker-chosen text landed
 * in centralised logging as a first-class, indexed field - fake log lines, a
 * poisoned trace search, and an unbounded string on a hot path.
 *
 * Nothing downstream parses the id, so the cheapest correct answer is to accept
 * only something that looks like an id and mint one otherwise. Honouring a
 * well-formed client id is still worth keeping: it is what lets a caller
 * correlate its own trace with ours.
 */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** First header value if the header was repeated; undefined if absent. */
function headerValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

/** The client's id if it is well-formed, otherwise a fresh one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = headerValue(header);
  return isValidRequestId(candidate) ? candidate : `req_${randomUUID()}`;
}

/**
 * The id to put in an error body. Prefers the id already resolved onto the
 * request (pino sets `req.id`), re-checks the raw header rather than trusting
 * it, and never invents a new id here - an error body claiming an id that
 * appears in no log line is worse than saying it does not know.
 */
export function requestIdForResponse(req: {
  id?: unknown;
  /** Loose on purpose: Express's IncomingHttpHeaders, or a plain object in a test. */
  headers?: Record<string, unknown>;
}): string {
  if (isValidRequestId(req.id)) return req.id;
  const raw = req.headers?.['x-request-id'];
  const candidate = headerValue(
    typeof raw === 'string' || Array.isArray(raw) ? (raw as string | string[]) : undefined,
  );
  return isValidRequestId(candidate) ? candidate : 'unknown';
}
