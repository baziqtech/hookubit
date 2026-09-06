import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION = 'v1';

/** Dot is the envelope separator, so it cannot appear in a key id. */
const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * What the ciphertext is bound to. Passed as AES-GCM additional authenticated
 * data, so a ciphertext moved anywhere else fails to authenticate.
 *
 * `owner` is the correction to an earlier overstatement (FIX 6). The AAD bound
 * only `<table>:<row id>`, and the docblock claimed that stopped an attacker
 * with DB write access from making the platform sign endpoint A's traffic with
 * a secret they control - it did not. Copying the ciphertext into endpoint B's
 * secret row was indeed rejected, but nothing stopped the same attacker from
 * UPDATE-ing A's own secret row to point at endpoint B: same row id, same AAD,
 * decrypts fine, now attached to a different endpoint.
 *
 * Binding the owning entity's id closes that: the row id says WHICH row the
 * ciphertext belongs to, `owner` says which endpoint that row is allowed to
 * serve. Re-pointing the row now makes it undecryptable, which is the outcome
 * the claim always described.
 *
 * The context is NOT stored in the envelope - it is derived from the row being
 * read, which is the whole point.
 */
export interface EncryptionContext {
  /** Physical table name, e.g. `endpoint_secrets`. */
  table: string;
  /** Primary key of the row the ciphertext belongs to. */
  id: string;
  /**
   * Id of the entity the row hangs off - `endpoint_secrets.endpoint_id` for a
   * signing secret. Required: an unbound ciphertext is the hole above.
   */
  owner: string;
}

interface Keyring {
  /** The key new ciphertext is written with. */
  primary: { kid: string; key: Buffer };
  /** Every key accepted for decryption, primary included, by kid. */
  byKid: Map<string, Buffer>;
}

function decodeKey(value: string, label: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`${label} must be ${KEY_BYTES} bytes, base64-encoded (got ${key.length})`);
  }
  return key;
}

/**
 * Envelope encryption for endpoint signing secrets (ARCHITECTURE.md 43).
 * Convoy's community build stores these in plaintext; here they are always
 * encrypted at rest.
 *
 * Format: `v1.<kid>.<iv>.<tag>.<ciphertext>`, every part base64url except the
 * key id.
 *
 * The key id is the fix for a rotation dead end. The original envelope named no
 * key, so changing ENCRYPTION_KEY made every endpoint_secrets row undecryptable
 * at once - a leaked key became a total outage rather than a rotation, which in
 * practice means the key never gets rotated at all. With a kid the service
 * accepts a keyring: one key designated for encryption, any number of retired
 * keys still accepted for decryption. Rotation is then: add the new key as
 * primary, keep the old one retired, re-encrypt in the background, drop it.
 *
 * There is deliberately NO legacy envelope (FIX 6). A four-part
 * `v1.<iv>.<tag>.<ciphertext>` form used to be accepted, decrypted with
 * `aad = undefined` - which is to say, accepted with the row binding switched
 * off. Anyone who could write to the database could strip the kid from an
 * envelope and hand it back as "legacy" to get exactly the cross-row move the
 * AAD exists to prevent. The migration that creates these tables has never run
 * outside CI, so no four-part ciphertext exists anywhere; the branch was a
 * permanent downgrade path guarding nothing. If one ever did exist, decrypt it
 * with a one-off script rather than reopening the path in the service.
 */
@Injectable()
export class CryptoService {
  private readonly keyring: Keyring;

  constructor(config: ConfigService) {
    this.keyring = CryptoService.buildKeyring(
      config.getOrThrow<string>('ENCRYPTION_KEY'),
      config.get<string>('ENCRYPTION_KEY_ID') ?? 'k1',
      config.get<string>('ENCRYPTION_KEYS_RETIRED') ?? '',
    );
  }

  /**
   * `retired` is a comma-separated list of `kid:base64key` pairs. Keys listed
   * there are accepted for decryption and never used for encryption.
   */
  static buildKeyring(primaryKey: string, primaryKid: string, retired: string): Keyring {
    if (!KID_PATTERN.test(primaryKid)) {
      throw new Error(`ENCRYPTION_KEY_ID must match ${KID_PATTERN} (got "${primaryKid}")`);
    }

    const byKid = new Map<string, Buffer>();
    byKid.set(primaryKid, decodeKey(primaryKey, 'ENCRYPTION_KEY'));

    for (const entry of retired.split(',').map((s) => s.trim()).filter(Boolean)) {
      const separator = entry.indexOf(':');
      if (separator < 1) {
        throw new Error(`ENCRYPTION_KEYS_RETIRED entries must be "<kid>:<base64key>" (got "${entry}")`);
      }
      const kid = entry.slice(0, separator);
      if (!KID_PATTERN.test(kid)) {
        throw new Error(`ENCRYPTION_KEYS_RETIRED key id must match ${KID_PATTERN} (got "${kid}")`);
      }
      if (byKid.has(kid)) {
        // Silently shadowing a key id would make decryption depend on parse
        // order, which is exactly the kind of bug that surfaces at rotation.
        throw new Error(`Duplicate encryption key id "${kid}"`);
      }
      byKid.set(kid, decodeKey(entry.slice(separator + 1), `ENCRYPTION_KEYS_RETIRED[${kid}]`));
    }

    return { primary: { kid: primaryKid, key: byKid.get(primaryKid)! }, byKid };
  }

  /** Key ids accepted for decryption. Exposed for the readiness probe. */
  get acceptedKeyIds(): string[] {
    return [...this.keyring.byKid.keys()];
  }

  get primaryKeyId(): string {
    return this.keyring.primary.kid;
  }

  private static aad(context: EncryptionContext): Buffer {
    if (!context?.table || !context?.id || !context?.owner) {
      throw new Error('Encryption context requires a table, a row id and an owner id');
    }
    return Buffer.from(`${context.table}:${context.id}:${context.owner}`, 'utf8');
  }

  encrypt(plaintext: string, context: EncryptionContext): string {
    const aad = CryptoService.aad(context);
    const { kid, key } = this.keyring.primary;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      kid,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** The five-part envelope is the only accepted form; see the class docblock. */
  decrypt(encoded: string, context: EncryptionContext): string {
    const parts = encoded.split('.');
    if (parts.length !== 5) throw new Error('Malformed ciphertext');

    const [version, kid, ivB64, tagB64, dataB64] = parts;
    if (version !== VERSION || !kid || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed ciphertext');
    }
    const key = this.keyring.byKid.get(kid);
    if (!key) {
      // Name the kid, never the key. An operator needs to know WHICH key is
      // missing from the ring to fix the deployment.
      throw new Error(`No encryption key configured for key id "${kid}"`);
    }
    return CryptoService.open(key, ivB64, tagB64, dataB64, CryptoService.aad(context));
  }

  private static open(
    key: Buffer,
    ivB64: string,
    tagB64: string,
    dataB64: string,
    aad: Buffer,
  ): string {
    const tag = Buffer.from(tagB64, 'base64url');
    if (tag.length !== TAG_BYTES) throw new Error('Malformed auth tag');
    const iv = Buffer.from(ivB64, 'base64url');
    if (iv.length !== IV_BYTES) throw new Error('Malformed iv');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Constant-time comparison for token/secret verification. */
  static safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
