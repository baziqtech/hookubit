import { generateApiKey } from '../common/api-key';
import { apiKeyState, isApiKeyUsable } from './api-key-state';

/**
 * The derivation restated independently of the implementation, against the Go
 * predicate it has to agree with:
 *
 *     revoked  := revoked_at IS NOT NULL AND revoked_at <= now
 *     expired  := expires_at IS NOT NULL AND expires_at <= now
 *
 * (`handler.go:247,250`, where the test is `!t.After(now)`.)
 */
describe('apiKeyState', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const before = new Date('2026-06-01T11:59:59.000Z');
  const after = new Date('2026-06-01T12:00:01.000Z');

  it('is active with neither timestamp set', () => {
    expect(apiKeyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(isApiKeyUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
  });

  it('is active while the expiry is still in the future', () => {
    expect(apiKeyState({ revokedAt: null, expiresAt: after }, now)).toBe('active');
  });

  it('is expired once the expiry has passed', () => {
    expect(apiKeyState({ revokedAt: null, expiresAt: before }, now)).toBe('expired');
    expect(isApiKeyUsable({ revokedAt: null, expiresAt: before }, now)).toBe(false);
  });

  it('treats an expiry exactly equal to now as already expired', () => {
    // The boundary the Go side takes. A control plane that said "active" here
    // would disagree with the data plane for the length of one clock tick and
    // send someone hunting a phantom outage.
    expect(apiKeyState({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
  });

  it('is revoked once revoked_at has passed, and rejects the key', () => {
    expect(apiKeyState({ revokedAt: before, expiresAt: null }, now)).toBe('revoked');
    expect(isApiKeyUsable({ revokedAt: before, expiresAt: null }, now)).toBe(false);
  });

  it('treats a revocation exactly equal to now as already revoked', () => {
    expect(apiKeyState({ revokedAt: now, expiresAt: null }, now)).toBe('revoked');
  });

  it('reports revoked ahead of expired when a key is both', () => {
    expect(apiKeyState({ revokedAt: before, expiresAt: before }, now)).toBe('revoked');
  });

  it('ignores a revocation scheduled in the future', () => {
    // Nothing writes one today, but the column is a timestamp and the Go check
    // is `<= now`; a future value must not retroactively kill a live key.
    expect(apiKeyState({ revokedAt: after, expiresAt: null }, now)).toBe('active');
  });
});

/**
 * The generator half of the same contract. `common/api-key.spec.ts` pins the
 * primitives against apikey.go; this pins the property the API-keys module
 * depends on - that the environment marker in the plaintext is the environment
 * the row is stamped with, since the ingest path compares the two.
 */
describe('generated keys', () => {
  it('carries the environment it was asked for, in the plaintext and in the record', () => {
    for (const environment of ['test', 'live'] as const) {
      const generated = generateApiKey(environment);
      expect(generated.key.startsWith(`wk_${environment}_`)).toBe(true);
      expect(generated.environment).toBe(environment);
      expect(generated.keyPrefix).toBe(generated.key.slice(0, 12));
    }
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey('live').key));
    expect(keys.size).toBe(200);
  });
});
