import { createHash } from 'node:crypto';
import {
  API_KEY_MIN_LENGTH,
  API_KEY_PREFIX_LENGTH,
  apiKeyEnvironment,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  isValidApiKeyShape,
} from './api-key';

/**
 * These assertions mirror services/data-plane/internal/ingest/apikey.go
 * literally. If one of them fails, control-plane-issued keys stop
 * authenticating against the data plane - which presents as "nothing works",
 * not as a test failure, so the constants are pinned here rather than shared.
 */
describe('API key contract with the Go data plane (FIX 9)', () => {
  it('pins the constants apikey.go hard-codes', () => {
    expect(API_KEY_PREFIX_LENGTH).toBe(12); // prefixLength
    expect(API_KEY_MIN_LENGTH).toBe('wk_live_'.length + 16); // minKeyLength
  });

  it('hashes as lowercase hex SHA-256 of the FULL plaintext key', () => {
    const generated = generateApiKey('live');
    const expected = createHash('sha256').update(generated.key, 'utf8').digest('hex');

    expect(generated.keyHash).toBe(expected);
    expect(generated.keyHash).toMatch(/^[0-9a-f]{64}$/);
    // Hashing the secret half, or a trimmed key, is the classic way to break this.
    expect(generated.keyHash).not.toBe(hashApiKey(generated.key.slice(8)));
  });

  it('matches a known vector, so a hashing change cannot pass silently', () => {
    expect(hashApiKey('wk_live_0123456789abcdef')).toBe(
      createHash('sha256').update('wk_live_0123456789abcdef', 'utf8').digest('hex'),
    );
    expect(hashApiKey('wk_live_0123456789abcdef')).toHaveLength(64);
  });

  it('stores the first 12 characters as the displayable prefix', () => {
    const generated = generateApiKey('test');

    expect(generated.keyPrefix).toBe(generated.key.slice(0, 12));
    expect(generated.keyPrefix.startsWith('wk_test_')).toBe(true);
    // The prefix must never be enough to reconstruct the key.
    expect(generated.key.startsWith(generated.keyPrefix)).toBe(true);
    expect(generated.keyPrefix.length).toBeLessThan(generated.key.length);
    expect(apiKeyPrefix('wk_')).toBe('wk_');
  });

  it('produces keys the Go shape validator accepts', () => {
    for (const env of ['live', 'test'] as const) {
      const { key } = generateApiKey(env);
      expect(key.startsWith(`wk_${env}_`)).toBe(true);
      expect(key.length).toBeGreaterThanOrEqual(API_KEY_MIN_LENGTH);
      expect(isValidApiKeyShape(key)).toBe(true);
      expect(apiKeyEnvironment(key)).toBe(env);
    }
  });

  it('rejects everything ValidateKeyShape rejects', () => {
    expect(isValidApiKeyShape('')).toBe(false);
    expect(isValidApiKeyShape('wk_live_short')).toBe(false); // under minKeyLength
    // xx_ deliberately, not a real vendor prefix - see apikey_test.go.
    expect(isValidApiKeyShape('xx_live_0123456789abcdefghij')).toBe(false); // wrong scheme
    expect(isValidApiKeyShape('wk_prod_0123456789abcdefghij')).toBe(false); // unknown env
    expect(isValidApiKeyShape('wk_live0123456789abcdefghijk')).toBe(false); // no separator
    expect(isValidApiKeyShape('wk_live_')).toBe(false); // empty secret
  });

  it('does not repeat itself', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey('live').key));
    expect(keys.size).toBe(200);
  });
});
