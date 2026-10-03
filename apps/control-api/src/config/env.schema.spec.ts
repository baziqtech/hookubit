import { validateEnv } from './env.schema';

const KEY_32 = Buffer.alloc(32, 7).toString('base64');
const SECRET_32 = 'x'.repeat(32);

/**
 * The MINIMUM environment that validates. APP_ENV is part of that minimum
 * because it is required and has no default - see the APP_ENV block in
 * env.schema.ts for why a deployment identity must not be guessed at.
 */
const baseEnv = (): Record<string, unknown> => ({
  APP_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/webhooks',
  JWT_SECRET: SECRET_32,
  SESSION_SECRET: SECRET_32,
  ENCRYPTION_KEY: KEY_32,
});

/**
 * staging/production additionally require a mail transport, a hop count and
 * the dashboard origin every mailed link is built on.
 */
const serverEnv = (): Record<string, unknown> => ({
  SMTP_URL: 'smtp://mailer:secret@mail.example.com:587',
  MAIL_FROM: 'HookuBit <no-reply@example.com>',
  TRUST_PROXY_HOPS: '2',
  DASHBOARD_URL: 'https://webhooks.example.com',
});

const smtpEnv = (): Record<string, unknown> => ({
  SMTP_URL: 'smtp://mailer:secret@mail.example.com:587',
  MAIL_FROM: 'HookuBit <no-reply@example.com>',
});

describe('validateEnv', () => {
  it('accepts a minimal environment with no optional values set', () => {
    const env = validateEnv(baseEnv());
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.DIRECT_DATABASE_URL).toBeUndefined();
    expect(env.CONTROL_API_PORT).toBe(3000);
    expect(env.APP_ENV).toBe('development');
  });

  /**
   * APP_ENV HAS NO DEFAULT, and that is the fix rather than an oversight.
   *
   * It defaulted to `development`, which is exactly the value
   * `auth/session.service.ts` uses to turn the session cookie's `Secure` flag
   * OFF. That service is careful - it opts OUT for `development` and `test`
   * only, so a misspelled `prod` still gets a Secure cookie - but the schema
   * default undid the care: an APP_ENV that was never set reached it as
   * `development` rather than as "unrecognised", so a production box whose env
   * file was missing the line sent its session cookie over plaintext HTTP,
   * silently.
   */
  describe('APP_ENV is required - a deployment identity is never guessed', () => {
    it.each([undefined, '', '  ', '\t', '\n '])(
      'REFUSES to boot with APP_ENV %j, naming the variable and the four legal values',
      (value) => {
        expect(() => validateEnv({ ...baseEnv(), APP_ENV: value })).toThrow(
          /APP_ENV: APP_ENV must be one of development\|test\|staging\|production, and it is REQUIRED/,
        );
      },
    );

    it('says WHY in the message, so the operator does not have to read the schema', () => {
      let message = '';
      try {
        validateEnv({ ...baseEnv(), APP_ENV: undefined });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('there is no default');
      expect(message).toContain('Secure');
    });

    it('refuses a MISSING key and a BLANK value identically - k8s secretRef injects blank', () => {
      const missing = { ...baseEnv() };
      delete missing.APP_ENV;
      expect(() => validateEnv(missing)).toThrow(/APP_ENV/);
      expect(() => validateEnv({ ...baseEnv(), APP_ENV: '' })).toThrow(/APP_ENV/);
    });
  });

  /**
   * TRUST_PROXY_HOPS has no default for the same reason, with a different
   * failure. 0 is the safe value when the answer is unknown - it under-counts
   * rather than trusting an attacker-supplied X-Forwarded-For - but it is not a
   * safe DEFAULT: 0 behind a proxy makes Express resolve every client to the
   * proxy, so ThrottleGuard's per-IP buckets collapse into ONE bucket for the
   * whole internet and the per-IP limits on login and password reset stop
   * existing. A box behind nginx that never set the line got that silently.
   */
  describe('TRUST_PROXY_HOPS must be STATED on an internet-facing environment', () => {
    it.each(['staging', 'production'])(
      'REFUSES to boot under APP_ENV=%s with no hop count, naming the correct value',
      (appEnv) => {
        const env: Record<string, unknown> = { ...baseEnv(), ...serverEnv(), APP_ENV: appEnv };
        delete env.TRUST_PROXY_HOPS;
        expect(() => validateEnv(env)).toThrow(
          new RegExp(`TRUST_PROXY_HOPS: TRUST_PROXY_HOPS is required when APP_ENV=${appEnv}`),
        );
      },
    );

    it.each(['', '  ', '\t'])('treats a blank hop count %j as unset, not as 0', (blank) => {
      expect(() =>
        validateEnv({ ...baseEnv(), ...serverEnv(), APP_ENV: 'production', TRUST_PROXY_HOPS: blank }),
      ).toThrow(/TRUST_PROXY_HOPS/);
    });

    it('names 2 - Cloudflare then nginx - so the message is actionable', () => {
      let message = '';
      const env: Record<string, unknown> = { ...baseEnv(), ...serverEnv(), APP_ENV: 'production' };
      delete env.TRUST_PROXY_HOPS;
      try {
        validateEnv(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('Use 2 for the standard deployment');
      expect(message).toContain('ONE bucket for the whole internet');
    });

    /**
     * The reason the default had to go rather than being kept alongside a
     * check: a box genuinely without a proxy must still be able to say 0, and
     * with `.default(0)` an unset variable and a deliberate 0 are the same
     * value by the time the refinement runs.
     */
    it('ACCEPTS a deliberate 0 in production - "nothing in front of me" is a legal answer', () => {
      const env = validateEnv({
        ...baseEnv(),
        ...serverEnv(),
        APP_ENV: 'production',
        TRUST_PROXY_HOPS: '0',
      });
      expect(env.TRUST_PROXY_HOPS).toBe(0);
    });

    it.each(['development', 'test'])(
      'does NOT require it under APP_ENV=%s, and still reports 0 to callers',
      (appEnv) => {
        const env = validateEnv({ ...baseEnv(), APP_ENV: appEnv });
        expect(env.TRUST_PROXY_HOPS).toBe(0);
      },
    );
  });

  /**
   * DASHBOARD_URL is the third variable of this shape, and its failure is the
   * only one that reaches END USERS. It defaulted to http://localhost:5173,
   * and it is the base of every link the service mails - /verify-email,
   * /reset-password, /accept-invitation - so a production box missing the line
   * sent real recipients password-reset links pointing at the operator's
   * laptop. The mail was accepted and delivered; only the link was dead, with
   * nothing refusing and nothing logged, so it looked like a mail fault.
   */
  describe('DASHBOARD_URL must be STATED on an internet-facing environment', () => {
    it.each(['staging', 'production'])(
      'REFUSES to boot under APP_ENV=%s with no dashboard origin, naming the variable',
      (appEnv) => {
        const env: Record<string, unknown> = { ...baseEnv(), ...serverEnv(), APP_ENV: appEnv };
        delete env.DASHBOARD_URL;
        expect(() => validateEnv(env)).toThrow(
          new RegExp(`DASHBOARD_URL: DASHBOARD_URL is required when APP_ENV=${appEnv}`),
        );
      },
    );

    it.each(['', '  ', '\t'])('treats a blank dashboard origin %j as unset', (blank) => {
      expect(() =>
        validateEnv({ ...baseEnv(), ...serverEnv(), APP_ENV: 'production', DASHBOARD_URL: blank }),
      ).toThrow(/DASHBOARD_URL: DASHBOARD_URL is required/);
    });

    it('names the consequence - dead links in real mail - so the message is actionable', () => {
      let message = '';
      const env: Record<string, unknown> = { ...baseEnv(), ...serverEnv(), APP_ENV: 'production' };
      delete env.DASHBOARD_URL;
      try {
        validateEnv(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('http://localhost:5173');
      expect(message).toContain('password-reset');
      expect(message).toContain('the link is dead');
      expect(message).toContain('CORS_ORIGINS');
    });

    /**
     * The same reason the TRUST_PROXY_HOPS default had to go: with
     * `.default('http://localhost:5173')` an unset variable and a deliberate
     * localhost value are one value by the time the refinement runs. A box
     * that really is served from localhost must still be able to say so.
     */
    it('ACCEPTS a deliberate localhost origin in production - it is a legal answer, just not a default', () => {
      const env = validateEnv({
        ...baseEnv(),
        ...serverEnv(),
        APP_ENV: 'production',
        DASHBOARD_URL: 'http://localhost:5173',
      });
      expect(env.DASHBOARD_URL).toBe('http://localhost:5173');
    });

    it.each(['development', 'test'])(
      'does NOT require it under APP_ENV=%s, and still reports a string to callers',
      (appEnv) => {
        const env = validateEnv({ ...baseEnv(), APP_ENV: appEnv });
        expect(env.DASHBOARD_URL).toBe('http://localhost:5173');
      },
    );
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
    // APP_ENV is deliberately NOT in this list any more: it has no default, so
    // a blank value is a refusal rather than a fallback. See the dedicated
    // describe block above.
    it.each([
      ['LOG_LEVEL', 'info'],
      ['ENCRYPTION_KEY_ID', 'k1'],
      ['ENCRYPTION_KEYS_RETIRED', ''],
      ['CORS_ORIGINS', ''],
    ] as const)('%s defaults when blank', (key, expected) => {
      const env = validateEnv({ ...baseEnv(), [key]: '  ' });
      expect(env[key]).toBe(expected);
    });

    // In development and test an absent or blank hop count reads as 0 - trust
    // nothing - so every caller still sees a number. It is NOT a schema
    // default: the transform that produces the 0 runs after the refinement
    // that requires the variable on staging and production.
    it('TRUST_PROXY_HOPS reads as 0 when unset or blank in development', () => {
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

    // staging/production need a mail transport and a hop count (see the blocks
    // above and below), so `serverEnv()` supplies both - this is checking
    // APP_ENV, not them.
    it.each(['development', 'test', 'staging', 'production'])('accepts APP_ENV %j', (value) => {
      expect(validateEnv({ ...baseEnv(), ...serverEnv(), APP_ENV: value }).APP_ENV).toBe(value);
    });

    it('rejects an unknown LOG_LEVEL', () => {
      expect(() => validateEnv({ ...baseEnv(), LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
    });
  });

  describe('tracing (OTEL_*)', () => {
    it('leaves the exporter endpoint unset by default - unset is the off switch', () => {
      const env = validateEnv(baseEnv());
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    });

    it.each(['', '  ', '\t'])(
      'treats a blank OTEL_EXPORTER_OTLP_ENDPOINT %j as unset rather than failing boot',
      (blank) => {
        const env = validateEnv({ ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: blank });
        expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      },
    );

    it('keeps a real collector endpoint', () => {
      const env = validateEnv({
        ...baseEnv(),
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
      });
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318');
    });

    it('REFUSES to boot on an endpoint that is not a URL', () => {
      expect(() =>
        validateEnv({ ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url at all' }),
      ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    });

    // `z.string().url()` alone accepts this: it reads `otel-collector:` as the
    // scheme. Omitting http:// is the likeliest mistake an operator makes, and
    // it would otherwise boot cleanly and export nothing, for ever.
    it('REFUSES an endpoint with no http(s) scheme', () => {
      expect(() =>
        validateEnv({ ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: 'otel-collector:4318' }),
      ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
      expect(() =>
        validateEnv({ ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://otel-collector:4317' }),
      ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    });

    it('accepts https', () => {
      const env = validateEnv({
        ...baseEnv(),
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
      });
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.example.com:4318');
    });

    it('defaults the service identity', () => {
      const env = validateEnv(baseEnv());
      expect(env.OTEL_SERVICE_NAME).toBe('control-api');
      expect(env.OTEL_SERVICE_NAMESPACE).toBe('hookubit');
    });

    it('defaults the sampler to 1 - the control plane is not the hot path', () => {
      expect(validateEnv(baseEnv()).OTEL_TRACES_SAMPLER_ARG).toBe(1);
      expect(validateEnv({ ...baseEnv(), OTEL_TRACES_SAMPLER_ARG: '  ' }).OTEL_TRACES_SAMPLER_ARG).toBe(1);
    });

    it('accepts a ratio in range and rejects one outside it', () => {
      expect(validateEnv({ ...baseEnv(), OTEL_TRACES_SAMPLER_ARG: '0.05' }).OTEL_TRACES_SAMPLER_ARG).toBe(0.05);
      expect(() => validateEnv({ ...baseEnv(), OTEL_TRACES_SAMPLER_ARG: '1.5' })).toThrow(
        /OTEL_TRACES_SAMPLER_ARG/,
      );
      expect(() => validateEnv({ ...baseEnv(), OTEL_TRACES_SAMPLER_ARG: '-1' })).toThrow(
        /OTEL_TRACES_SAMPLER_ARG/,
      );
      expect(() => validateEnv({ ...baseEnv(), OTEL_TRACES_SAMPLER_ARG: 'half' })).toThrow(
        /OTEL_TRACES_SAMPLER_ARG/,
      );
    });
  });

  describe('outbound mail (SMTP_URL, MAIL_FROM, DASHBOARD_URL)', () => {
    it('leaves SMTP_URL unset by default in development - unset means the logging stub', () => {
      const env = validateEnv(baseEnv());
      expect(env.SMTP_URL).toBeUndefined();
      expect(env.MAIL_FROM).toBeUndefined();
    });

    it.each(['', '  ', '\t'])('treats a blank SMTP_URL %j as unset', (blank) => {
      expect(validateEnv({ ...baseEnv(), SMTP_URL: blank }).SMTP_URL).toBeUndefined();
    });

    it('keeps a real smtp:// and smtps:// URL, credentials and all', () => {
      expect(validateEnv({ ...baseEnv(), ...smtpEnv() }).SMTP_URL).toBe(
        'smtp://mailer:secret@mail.example.com:587',
      );
      expect(
        validateEnv({ ...baseEnv(), ...smtpEnv(), SMTP_URL: 'smtps://mail.example.com:465' }).SMTP_URL,
      ).toBe('smtps://mail.example.com:465');
    });

    // `z.string().url()` accepts `mail.example.com:587`, reading the host as
    // the scheme - the same trap OTEL_EXPORTER_OTLP_ENDPOINT closes.
    it.each(['mail.example.com:587', 'localhost:1025', 'http://mail.example.com', 'not a url'])(
      'REFUSES SMTP_URL %j - no smtp/smtps scheme',
      (value) => {
        expect(() => validateEnv({ ...baseEnv(), ...smtpEnv(), SMTP_URL: value })).toThrow(
          /SMTP_URL/,
        );
      },
    );

    it('REFUSES SMTP_URL without MAIL_FROM - a transport with no sender', () => {
      expect(() =>
        validateEnv({ ...baseEnv(), SMTP_URL: 'smtp://mail.example.com:587' }),
      ).toThrow(/MAIL_FROM is required when SMTP_URL is set/);
      expect(() =>
        validateEnv({ ...baseEnv(), SMTP_URL: 'smtp://mail.example.com:587', MAIL_FROM: '  ' }),
      ).toThrow(/MAIL_FROM/);
    });

    it.each(['HookuBit <no-reply@example.com>', 'no-reply@example.com', 'no-reply@localhost'])(
      'accepts MAIL_FROM %j',
      (value) => {
        expect(validateEnv({ ...baseEnv(), ...smtpEnv(), MAIL_FROM: value }).MAIL_FROM).toBe(value);
      },
    );

    it.each(['HookuBit', 'HookuBit <not-an-address>', 'a@b, c@d'])('REFUSES MAIL_FROM %j', (value) => {
      expect(() => validateEnv({ ...baseEnv(), ...smtpEnv(), MAIL_FROM: value })).toThrow(/MAIL_FROM/);
    });

    it.each(['staging', 'production'])(
      'REFUSES to boot under APP_ENV=%s with no SMTP_URL, naming the variable',
      (appEnv) => {
        // TRUST_PROXY_HOPS and DASHBOARD_URL are supplied - the other two
        // staging/production requirements - so SMTP_URL is the ONLY thing at
        // fault and the message is about it alone.
        expect(() =>
          validateEnv({
            ...baseEnv(),
            APP_ENV: appEnv,
            TRUST_PROXY_HOPS: '2',
            DASHBOARD_URL: 'https://webhooks.example.com',
          }),
        ).toThrow(new RegExp(`SMTP_URL: SMTP_URL is required when APP_ENV=${appEnv}`));
      },
    );

    it.each(['development', 'test'])('boots under APP_ENV=%s with no SMTP_URL', (appEnv) => {
      expect(validateEnv({ ...baseEnv(), APP_ENV: appEnv }).SMTP_URL).toBeUndefined();
    });

    /**
     * Only in development and test, and only through the transform that runs
     * after the refinement - under staging/production an absent or blank value
     * refuses the boot instead. See the DASHBOARD_URL describe block above.
     */
    it('reads as the local dev server under development, blank included', () => {
      expect(validateEnv(baseEnv()).DASHBOARD_URL).toBe('http://localhost:5173');
      expect(validateEnv({ ...baseEnv(), DASHBOARD_URL: '' }).DASHBOARD_URL).toBe(
        'http://localhost:5173',
      );
    });

    it('keeps a real DASHBOARD_URL and REFUSES one with no http(s) scheme - it is the base of every link', () => {
      expect(validateEnv({ ...baseEnv(), DASHBOARD_URL: 'https://app.example.com' }).DASHBOARD_URL).toBe(
        'https://app.example.com',
      );
      expect(() => validateEnv({ ...baseEnv(), DASHBOARD_URL: 'app.example.com' })).toThrow(
        /DASHBOARD_URL/,
      );
      expect(() => validateEnv({ ...baseEnv(), DASHBOARD_URL: 'app.example.com:5173' })).toThrow(
        /DASHBOARD_URL/,
      );
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
