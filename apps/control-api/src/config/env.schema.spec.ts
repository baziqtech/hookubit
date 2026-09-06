import { validateEnv } from './env.schema';

const KEY_32 = Buffer.alloc(32, 7).toString('base64');
const SECRET_32 = 'x'.repeat(32);

const baseEnv = (): Record<string, unknown> => ({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/webhooks',
  JWT_SECRET: SECRET_32,
  SESSION_SECRET: SECRET_32,
  ENCRYPTION_KEY: KEY_32,
});

describe('validateEnv', () => {
  it('accepts a minimal environment with no optional values set', () => {
    const env = validateEnv(baseEnv());
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.DIRECT_DATABASE_URL).toBeUndefined();
    expect(env.CONTROL_API_PORT).toBe(3000);
    expect(env.APP_ENV).toBe('development');
  });

  describe('blank optional URLs (k8s secretRef / compose ${VAR:-} inject "")', () => {
    it.each(['', ' ', '   ', '\t', '\n '])(
      'parses REDIS_URL %j as undefined rather than failing',
      (blank) => {
        const env = validateEnv({ ...baseEnv(), REDIS_URL: blank });
        expect(env.REDIS_URL).toBeUndefined();
      },
    );

    it.each(['', '  '])('parses DIRECT_DATABASE_URL %j as undefined', (blank) => {
      const env = validateEnv({ ...baseEnv(), DIRECT_DATABASE_URL: blank });
      expect(env.DIRECT_DATABASE_URL).toBeUndefined();
    });

    it('still keeps a real REDIS_URL', () => {
      const env = validateEnv({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379' });
      expect(env.REDIS_URL).toBe('redis://localhost:6379');
    });
  });

  describe('blank optional non-URL fields fall back to their defaults', () => {
    it.each([
      ['APP_ENV', 'development'],
      ['LOG_LEVEL', 'info'],
      ['ENCRYPTION_KEY_ID', 'k1'],
      ['ENCRYPTION_KEYS_RETIRED', ''],
      ['CORS_ORIGINS', ''],
    ] as const)('%s defaults when blank', (key, expected) => {
      const env = validateEnv({ ...baseEnv(), [key]: '  ' });
      expect(env[key]).toBe(expected);
    });

    it('TRUST_PROXY_HOPS defaults to 0 - trust nothing - when unset or blank', () => {
      expect(validateEnv(baseEnv()).TRUST_PROXY_HOPS).toBe(0);
      expect(validateEnv({ ...baseEnv(), TRUST_PROXY_HOPS: '  ' }).TRUST_PROXY_HOPS).toBe(0);
    });

    it('accepts an exact hop count', () => {
      expect(validateEnv({ ...baseEnv(), TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
      expect(validateEnv({ ...baseEnv(), TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    });

    it.each(['true', '-1', '1.5', 'all', '99'])(
      'rejects TRUST_PROXY_HOPS %j: an inexact hop count is a forgeable X-Forwarded-For',
      (value) => {
        expect(() => validateEnv({ ...baseEnv(), TRUST_PROXY_HOPS: value })).toThrow(
          /TRUST_PROXY_HOPS/,
        );
      },
    );

    it('CONTROL_API_PORT defaults when blank instead of coercing to 0', () => {
      expect(validateEnv({ ...baseEnv(), CONTROL_API_PORT: '' }).CONTROL_API_PORT).toBe(3000);
      expect(validateEnv({ ...baseEnv(), CONTROL_API_PORT: '8080' }).CONTROL_API_PORT).toBe(8080);
    });

    it('ALLOW_OPEN_REGISTRATION defaults to false when blank', () => {
      expect(validateEnv({ ...baseEnv(), ALLOW_OPEN_REGISTRATION: '' }).ALLOW_OPEN_REGISTRATION).toBe(
        false,
      );
      expect(
        validateEnv({ ...baseEnv(), ALLOW_OPEN_REGISTRATION: 'true' }).ALLOW_OPEN_REGISTRATION,
      ).toBe(true);
    });
  });

  describe('malformed non-empty values still fail', () => {
    it('rejects a garbage REDIS_URL', () => {
      expect(() => validateEnv({ ...baseEnv(), REDIS_URL: 'not-a-url' })).toThrow(/REDIS_URL/);
    });

    it('rejects a garbage DIRECT_DATABASE_URL', () => {
      expect(() => validateEnv({ ...baseEnv(), DIRECT_DATABASE_URL: 'not a url at all' })).toThrow(
        /DIRECT_DATABASE_URL/,
      );
    });

    /**
     * SessionService turns APP_ENV into a Secure-cookie decision, so an APP_ENV
     * the schema let through unrecognised would be a security decision made by
     * a typo (FIX 3).
     */
    it.each(['prod', 'Production', 'PRODUCTION', 'dev', 'live'])(
      'rejects the unrecognised APP_ENV %j instead of letting a typo pick a code path',
      (value) => {
        expect(() => validateEnv({ ...baseEnv(), APP_ENV: value })).toThrow(/APP_ENV/);
      },
    );

    it.each(['development', 'test', 'staging', 'production'])('accepts APP_ENV %j', (value) => {
      expect(validateEnv({ ...baseEnv(), APP_ENV: value }).APP_ENV).toBe(value);
    });

    it('rejects an unknown LOG_LEVEL', () => {
      expect(() => validateEnv({ ...baseEnv(), LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
    });
  });

  describe('required configuration still fails loudly when blank', () => {
    it.each(['', '   ', undefined])('rejects DATABASE_URL %j', (value) => {
      expect(() => validateEnv({ ...baseEnv(), DATABASE_URL: value })).toThrow(/DATABASE_URL/);
    });

    it.each(['', '   ', undefined])('rejects JWT_SECRET %j', (value) => {
      expect(() => validateEnv({ ...baseEnv(), JWT_SECRET: value })).toThrow(/JWT_SECRET/);
    });

    it.each(['', '   ', undefined])('rejects SESSION_SECRET %j', (value) => {
      expect(() => validateEnv({ ...baseEnv(), SESSION_SECRET: value })).toThrow(/SESSION_SECRET/);
    });

    it.each(['', '   ', undefined])('rejects ENCRYPTION_KEY %j', (value) => {
      expect(() => validateEnv({ ...baseEnv(), ENCRYPTION_KEY: value })).toThrow(/ENCRYPTION_KEY/);
    });

    it('reports every failure at once', () => {
      expect(() =>
        validateEnv({ ...baseEnv(), DATABASE_URL: '', JWT_SECRET: '' }),
      ).toThrow(/Invalid environment configuration/);
    });
  });
});
