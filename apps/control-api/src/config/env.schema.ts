import { z } from 'zod';

/**
 * Kubernetes `envFrom.secretRef` and Docker Compose `${VAR:-}` both inject an
 * unset value as a SET-but-empty environment variable. Zod's `.optional()`
 * accepts `undefined` but rejects `''`, so an optional-but-empty var (Redis is
 * genuinely optional here) fails validation and the control plane refuses to
 * boot on its own documented happy path.
 *
 * Treat blank as "not configured" for every field where that is what it plainly
 * means. Required secrets deliberately do NOT get this treatment: an empty
 * DATABASE_URL or ENCRYPTION_KEY must still fail loudly.
 */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/** Wraps a schema so a blank/whitespace-only string is seen as `undefined`. */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema);

/**
 * Fail fast and loudly on bad configuration. A control plane that boots with a
 * missing ENCRYPTION_KEY and discovers it at secret-rotation time is worse than
 * one that refuses to start.
 */
export const envSchema = z.object({
  APP_ENV: blankAsUnset(
    z.enum(['development', 'test', 'staging', 'production']).default('development'),
  ),
  LOG_LEVEL: blankAsUnset(
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ),

  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: blankAsUnset(z.string().url().optional()),

  REDIS_URL: blankAsUnset(z.string().url().optional()),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  /** The key new ciphertext is written with. */
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'ENCRYPTION_KEY must be 32 bytes, base64-encoded',
    ),
  /**
   * Names ENCRYPTION_KEY inside the ciphertext envelope so it can be rotated.
   * Bump it whenever ENCRYPTION_KEY changes and move the old pair into
   * ENCRYPTION_KEYS_RETIRED; without the id, rotating the key makes every
   * endpoint_secrets row undecryptable at once.
   */
  ENCRYPTION_KEY_ID: blankAsUnset(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,16}$/, 'ENCRYPTION_KEY_ID must be 1-16 chars of [A-Za-z0-9_-]')
      .default('k1'),
  ),
  /**
   * Comma-separated `<kid>:<base64key>` pairs accepted for DECRYPTION only.
   * Keep the previous key here until every row has been re-encrypted.
   */
  ENCRYPTION_KEYS_RETIRED: blankAsUnset(z.string().default('')),

  CONTROL_API_PORT: blankAsUnset(z.coerce.number().int().positive().default(3000)),
  /**
   * Number of reverse proxies in front of this process, used verbatim as
   * Express's `trust proxy` hop count (see `applyTrustProxy`).
   *
   * It must be EXACT. Too low and X-Forwarded-For is ignored, so every request
   * behind the ingress shares one rate-limit bucket and ~15 anonymous requests
   * an hour lock every user out of login. Too high - and `true` is "infinitely
   * high" - and a client can prepend its own X-Forwarded-For entry, choose a
   * fresh source address per request, and evade the bucket entirely.
   *
   * Default 0 (no proxy) because that is the only value that is safe when
   * unknown: it under-counts rather than trusting an attacker-supplied header.
   */
  TRUST_PROXY_HOPS: blankAsUnset(z.coerce.number().int().min(0).max(10).default(0)),
  CORS_ORIGINS: blankAsUnset(z.string().default('')),
  ALLOW_OPEN_REGISTRATION: blankAsUnset(
    z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
  ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
