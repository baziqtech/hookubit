import { ConfigService } from '@nestjs/config';
import { createCipheriv, randomBytes } from 'node:crypto';
import { CryptoService, EncryptionContext } from './crypto.service';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const CONTEXT: EncryptionContext = { table: 'endpoint_secrets', id: 'eps_A', owner: 'ep_A' };
const OTHER_ROW: EncryptionContext = { table: 'endpoint_secrets', id: 'eps_B', owner: 'ep_B' };
/** Same row, re-pointed at another endpoint - the move the old AAD allowed. */
const REPOINTED_ROW: EncryptionContext = { ...CONTEXT, owner: 'ep_B' };

function build(vars: Record<string, string>): CryptoService {
  const config = {
    getOrThrow: (key: string): string => {
      const value = vars[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
    get: (key: string): string | undefined => vars[key],
  } as unknown as ConfigService;
  return new CryptoService(config);
}

/** The removed envelope: v1.<iv>.<tag>.<ct>, no key id, and crucially no AAD. */
function legacyEncrypt(keyB64: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

describe('CryptoService envelope', () => {
  it('round-trips and never leaks the plaintext into the envelope', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });
    const secret = 'whsec_super_secret_value';

    const encoded = crypto.encrypt(secret, CONTEXT);

    expect(encoded).not.toContain(secret);
    expect(crypto.decrypt(encoded, CONTEXT)).toBe(secret);
  });

  it('names the key in the envelope so the key can be rotated', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k7' });

    const parts = crypto.encrypt('s', CONTEXT).split('.');

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('k7');
    expect(crypto.primaryKeyId).toBe('k7');
  });
});

describe('CryptoService key rotation (FIX 6)', () => {
  it('decrypts ciphertext written under a retired key after rotation', () => {
    const before = build({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k1' });
    const encoded = before.encrypt('rotate me', CONTEXT);

    // Rotate: k2 becomes primary, k1 is retained for decryption only.
    const after = build({
      ENCRYPTION_KEY: KEY_B,
      ENCRYPTION_KEY_ID: 'k2',
      ENCRYPTION_KEYS_RETIRED: `k1:${KEY_A}`,
    });

    expect(after.decrypt(encoded, CONTEXT)).toBe('rotate me');
    expect(after.encrypt('new', CONTEXT).split('.')[1]).toBe('k2');
    expect(after.acceptedKeyIds.sort()).toEqual(['k1', 'k2']);
  });

  it('fails with the missing key id named, not with a generic auth error', () => {
    const before = build({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k1' });
    const encoded = before.encrypt('orphan', CONTEXT);

    // The operator forgot ENCRYPTION_KEYS_RETIRED. This is the outage the fix
    // exists to make diagnosable.
    const after = build({ ENCRYPTION_KEY: KEY_B, ENCRYPTION_KEY_ID: 'k2' });

    expect(() => after.decrypt(encoded, CONTEXT)).toThrow(/key id "k1"/);
  });

  it('rejects a duplicate key id rather than letting parse order decide', () => {
    expect(() =>
      build({
        ENCRYPTION_KEY: KEY_A,
        ENCRYPTION_KEY_ID: 'k1',
        ENCRYPTION_KEYS_RETIRED: `k1:${KEY_B}`,
      }),
    ).toThrow(/Duplicate encryption key id/);
  });

  it('rejects a key id containing the envelope separator', () => {
    expect(() => build({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k.1' })).toThrow(
      /ENCRYPTION_KEY_ID/,
    );
  });

  it('rejects a retired key of the wrong length', () => {
    expect(() =>
      build({
        ENCRYPTION_KEY: KEY_A,
        ENCRYPTION_KEYS_RETIRED: `k0:${randomBytes(16).toString('base64')}`,
      }),
    ).toThrow(/32 bytes/);
  });
});

/**
 * REGRESSION (FIX 6): the four-part envelope was a permanent downgrade path.
 *
 * It decrypted with `aad = undefined` - the row binding simply switched off -
 * so anyone who could write to the database could strip the kid off a five-part
 * envelope and present the remainder as "legacy" to move a signing secret
 * between rows. Nothing has ever written one outside CI, so it protected no
 * data at all.
 */
describe('CryptoService legacy envelope removal', () => {
  it('refuses the four-part envelope outright', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k1' });
    const legacy = legacyEncrypt(KEY_A, 'written before key ids existed');

    expect(legacy.split('.')).toHaveLength(4);
    expect(() => crypto.decrypt(legacy, CONTEXT)).toThrow(/Malformed ciphertext/);
  });

  it('cannot be re-entered by stripping the kid off a real envelope', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A, ENCRYPTION_KEY_ID: 'k1' });
    const [version, , iv, tag, ct] = crypto.encrypt('endpoint A signing secret', CONTEXT).split('.');

    // The downgrade attack: drop the kid, present four parts, get AAD-free
    // decryption and with it the freedom to bind the secret to any row.
    const downgraded = [version, iv, tag, ct].join('.');

    expect(() => crypto.decrypt(downgraded, CONTEXT)).toThrow(/Malformed ciphertext/);
    expect(() => crypto.decrypt(downgraded, OTHER_ROW)).toThrow(/Malformed ciphertext/);
  });

  it('still round-trips the five-part envelope it replaced it with', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });
    expect(crypto.decrypt(crypto.encrypt('current', CONTEXT), CONTEXT)).toBe('current');
  });
});

describe('CryptoService AAD row binding (FIX 6)', () => {
  it('refuses a ciphertext copied onto a different row', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });
    const stolen = crypto.encrypt('endpoint A signing secret', CONTEXT);

    // An attacker with DB write access pastes endpoint A's secret onto B.
    expect(() => crypto.decrypt(stolen, OTHER_ROW)).toThrow();
    expect(crypto.decrypt(stolen, CONTEXT)).toBe('endpoint A signing secret');
  });

  it('refuses a ciphertext copied into a different table', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });
    const encoded = crypto.encrypt('s', { table: 'endpoint_secrets', id: 'x', owner: 'ep_A' });

    expect(() => crypto.decrypt(encoded, { table: 'api_keys', id: 'x', owner: 'ep_A' })).toThrow();
  });

  /**
   * The claim the docblock used to make but the code did not keep: an attacker
   * who cannot paste the ciphertext into endpoint B's row can simply UPDATE
   * endpoint A's own row to say `endpoint_id = B`. Row id unchanged, old AAD
   * unchanged, and the platform then signs B's traffic with A's secret.
   */
  it('refuses a row that has been re-pointed at another endpoint', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });
    const secret = crypto.encrypt('endpoint A signing secret', CONTEXT);

    expect(() => crypto.decrypt(secret, REPOINTED_ROW)).toThrow();
    expect(crypto.decrypt(secret, CONTEXT)).toBe('endpoint A signing secret');
  });

  it.each([
    ['table', { table: '', id: 'eps_A', owner: 'ep_A' }],
    ['row id', { table: 'endpoint_secrets', id: '', owner: 'ep_A' }],
    ['owner id', { table: 'endpoint_secrets', id: 'eps_A', owner: '' }],
  ])('refuses to encrypt with a missing %s rather than binding to nothing', (_label, context) => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });

    expect(() => crypto.encrypt('s', context as EncryptionContext)).toThrow(/Encryption context/);
    expect(() => crypto.decrypt(crypto.encrypt('s', CONTEXT), context as EncryptionContext)).toThrow(
      /Encryption context/,
    );
  });

  it('rejects a tampered ciphertext, tag and iv', () => {
    const crypto = build({ ENCRYPTION_KEY: KEY_A });
    const [v, kid, iv, tag, ct] = crypto.encrypt('tamper', CONTEXT).split('.');

    expect(() => crypto.decrypt([v, kid, iv, tag, `${ct}AA`].join('.'), CONTEXT)).toThrow();
    expect(() => crypto.decrypt([v, kid, iv, 'AAAA', ct].join('.'), CONTEXT)).toThrow();
    expect(() => crypto.decrypt('not-an-envelope', CONTEXT)).toThrow(/Malformed ciphertext/);
  });
});
