import type { Environment } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';

/**
 * API key wire format and hashing.
 *
 * THIS FILE IS A CONTRACT WITH THE GO DATA PLANE. Its authenticating half lives
 * in services/data-plane/internal/ingest/apikey.go and is not ours to change.
 * The two must agree exactly or nothing authenticates:
 *
 *   shape    wk_live_<secret> / wk_test_<secret>, secret non-empty
 *   minimum  len("wk_live_") + 16 = 24 characters, checked before hashing
 *   hash     lowercase hex SHA-256 of the FULL plaintext key (api_keys.key_hash)
 *   prefix   the first 12 characters (api_keys.key_prefix), safe to display
 *
 * Only the hash is stored. The plaintext is returned once, at creation, and
 * never logged.
 */

export const API_KEY_SCHEME = 'wk_';
/** Mirrors `prefixLength` in apikey.go. Covers "wk_live_" plus four random chars. */
export const API_KEY_PREFIX_LENGTH = 12;
/** Mirrors `minKeyLength` in apikey.go. */
export const API_KEY_MIN_LENGTH = 'wk_live_'.length + 16;
/** Secret length in characters; 32 over a 62-character alphabet is ~190 bits. */
export const API_KEY_SECRET_LENGTH = 32;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface GeneratedApiKey {
  /** Plaintext. Show once, store never. */
  key: string;
  /** Lowercase hex SHA-256 of `key`. This is what goes in api_keys.key_hash. */
  keyHash: string;
  /** api_keys.key_prefix. */
  keyPrefix: string;
  environment: Environment;
}

/** Lowercase hex SHA-256 of the full plaintext key - `HashKey` in apikey.go. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Safe-to-display leading fragment - `KeyPrefix` in apikey.go. */
export function apiKeyPrefix(key: string): string {
  return key.length <= API_KEY_PREFIX_LENGTH ? key : key.slice(0, API_KEY_PREFIX_LENGTH);
}

/**
 * The environment a well-formed key claims - `KeyEnvironment` in apikey.go.
 * The claim is attacker-controlled; always compare it against the api_keys row.
 */
export function apiKeyEnvironment(key: string): string {
  const rest = key.startsWith(API_KEY_SCHEME) ? key.slice(API_KEY_SCHEME.length) : key;
  const separator = rest.indexOf('_');
  return separator === -1 ? '' : rest.slice(0, separator);
}

/** Mirrors `ValidateKeyShape` in apikey.go. */
export function isValidApiKeyShape(key: string): boolean {
  if (key.length < API_KEY_MIN_LENGTH || !key.startsWith(API_KEY_SCHEME)) return false;
  const rest = key.slice(API_KEY_SCHEME.length);
  const separator = rest.indexOf('_');
  if (separator === -1) return false;
  const env = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (secret.length === 0) return false;
  return env === 'live' || env === 'test';
}

/**
 * `randomInt` rather than `randomBytes(n) % 62`: modulo over 256 is biased
 * toward the first 8 characters of the alphabet, which quietly costs entropy.
 */
function randomSecret(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateApiKey(environment: Environment): GeneratedApiKey {
  const key = `${API_KEY_SCHEME}${environment}_${randomSecret(API_KEY_SECRET_LENGTH)}`;
  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: apiKeyPrefix(key),
    environment,
  };
}
