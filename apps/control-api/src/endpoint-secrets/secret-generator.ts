import { randomBytes } from 'node:crypto';

/**
 * Prefix on every signing secret.
 *
 * It is part of the secret - `signing.Sign` uses the whole string as the HMAC
 * key, so a consumer must store it verbatim, prefix included. It exists so a
 * secret is recognisable on sight: in a support ticket, in a `git grep` over a
 * customer's repository, and to the secret scanners that watch public pushes.
 */
export const SIGNING_SECRET_PREFIX = 'whsec_';

/** 256 bits, which is the HMAC-SHA256 block-independent key size. */
export const SIGNING_SECRET_BYTES = 32;

/**
 * A new endpoint signing secret.
 *
 * base64url rather than hex: the same entropy in 43 characters instead of 64,
 * and no character that needs escaping in a `.env` file, a YAML value or a URL.
 */
export function generateSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${randomBytes(SIGNING_SECRET_BYTES).toString('base64url')}`;
}

/**
 * The default overlap window: both the old and the new secret sign every
 * delivery for a day.
 *
 * `signing.Header` emits one `v1=` per active secret and `signing.Verify`
 * accepts a delivery if ANY of them matches, so during this window a consumer
 * can be redeployed with the new secret at any moment without dropping a
 * delivery - which is the entire point of rotation. A day is long enough to
 * cover a normal deploy window and a weekend is not, deliberately: a secret that
 * overlaps forever has not been rotated.
 */
export const DEFAULT_OVERLAP_SECONDS = 24 * 60 * 60;

/**
 * Zero is allowed and means "the old secret stops signing now" - the correct
 * response to a leaked secret, and the reason this is a parameter rather than a
 * constant. It is safe only because the new secret is created BEFORE the old one
 * is expired, so the endpoint never passes through zero active secrets.
 */
export const MIN_OVERLAP_SECONDS = 0;

/** Thirty days. Past this the old secret is not overlapping, it is just live. */
export const MAX_OVERLAP_SECONDS = 30 * 24 * 60 * 60;
