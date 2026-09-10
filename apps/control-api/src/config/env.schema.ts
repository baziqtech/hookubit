import { z } from 'zod';
import { parseMailbox } from '../notifications/mailbox';

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

  /**
   * Endpoint auto-disable (docs/FAILURE_RECOVERY.md G14).
   *
   * On by default. The gap this closes is that a permanently dead endpoint kept
   * accruing a delivery row for every matching event for ever, and a reaper
   * that has to be discovered and switched on has not closed it. Setting this
   * false restores the old behaviour and says so loudly at boot.
   */
  ENDPOINT_AUTO_DISABLE_ENABLED: blankAsUnset(
    z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
  ),
  /**
   * How long the circuit breaker must have been CONTINUOUSLY open first. See
   * `DEFAULT_AUTO_DISABLE_AFTER_HOURS` for why 72.
   *
   * The floor is 24 hours and it is not adjustable downwards: a delivery's own
   * wall-clock budget is `max_retry_duration`, 24h by default, so a shorter
   * window would disable an endpoint while the deliveries it is failing are
   * still legitimately being retried - and cancel them.
   */
  ENDPOINT_AUTO_DISABLE_AFTER_HOURS: blankAsUnset(
    z.coerce.number().int().min(24).max(24 * 365).default(72),
  ),
  ENDPOINT_AUTO_DISABLE_INTERVAL_MINUTES: blankAsUnset(
    z.coerce.number().int().min(1).max(1440).default(15),
  ),
  /** Endpoints one pass may disable. Bounds the transaction and the mistake. */
  ENDPOINT_AUTO_DISABLE_MAX_PER_RUN: blankAsUnset(
    z.coerce.number().int().min(1).max(10_000).default(200),
  ),
  /**
   * Tracing (ARCHITECTURE.md 44, docs/ROADMAP.md Phase 6).
   *
   * The BASE OTLP/HTTP endpoint of a collector - `http://otel-collector:4318`,
   * not `.../v1/traces`; the signal path is appended for you. UNSET IS THE
   * SWITCH: with no endpoint the control plane builds no exporter, no span
   * processor and no tracer provider at all, so there is nothing to retry
   * against a collector that does not exist and nothing to slow boot down.
   *
   * Validated as an http(s) URL rather than accepted as free text because a
   * typo here would otherwise surface as a silent export failure hours later -
   * the one failure mode the whole "controls must not lie" rule exists to
   * prevent. The scheme check is not redundant: `z.string().url()` accepts
   * `otel-collector:4318`, reading the host as a URL SCHEME, so the most likely
   * mistake an operator makes - omitting `http://` - is the one a bare `.url()`
   * would have waved through.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: blankAsUnset(
    z
      .string()
      .url()
      .refine(
        (v) => /^https?:\/\//i.test(v),
        'OTEL_EXPORTER_OTLP_ENDPOINT must start with http:// or https:// (the collector base URL, e.g. http://otel-collector:4318)',
      )
      .optional(),
  ),
  /**
   * `service.namespace` on every span. Groups this deployment's services in the
   * trace backend, so a shared collector can carry two installs without their
   * `control-api` spans merging into one service.
   */
  OTEL_SERVICE_NAMESPACE: blankAsUnset(
    z
      .string()
      .max(64, 'OTEL_SERVICE_NAMESPACE must be at most 64 characters')
      .default('webhook-platform'),
  ),
  /**
   * `service.name` on every span. Overridable because a self-hosted install may
   * run two control planes (staging and production) against one collector, and
   * `service.namespace` alone does not separate them in every backend.
   */
  OTEL_SERVICE_NAME: blankAsUnset(
    z
      .string()
      .max(64, 'OTEL_SERVICE_NAME must be at most 64 characters')
      .default('control-api'),
  ),
  /**
   * Head sampling ratio, 0..1, parent-based. Defaults to 1: the control plane
   * is the configuration and operator surface, deliberately NOT the delivery
   * hot path (that is the Go data plane), so its request rate is small enough
   * that sampling buys nothing and losing the one slow request costs a lot.
   *
   * Parent-based, but the remote-parent branch is capped at this same ratio
   * rather than obeying it: `traceparent` is an unauthenticated request header,
   * and a caller must not get to decide how much we record. See the sampler in
   * tracing/tracer-provider.service.ts.
   */
  OTEL_TRACES_SAMPLER_ARG: blankAsUnset(z.coerce.number().min(0).max(1).default(1)),

  ALLOW_OPEN_REGISTRATION: blankAsUnset(
    z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
  ),

  /**
   * Outbound mail (notifications module).
   *
   * `DASHBOARD_URL` is the base of every link a message carries -
   * `/verify-email?token=`, `/reset-password?token=`,
   * `/accept-invitation?token=`. A wrong value here is a mail full of dead
   * links, so the scheme is checked the way OTEL's is: `app.example.com`
   * parses as a URL with scheme `app.example.com` and would boot cleanly.
   */
  DASHBOARD_URL: blankAsUnset(
    z
      .string()
      .url()
      .refine(
        (v) => /^https?:\/\//i.test(v),
        'DASHBOARD_URL must start with http:// or https:// (the dashboard origin, e.g. https://app.example.com)',
      )
      .default('http://localhost:5173'),
  ),
  /**
   * SMTP connection URL, `smtp://user:pass@host:587` or `smtps://…`. SET IS
   * THE SWITCH: with it, the SMTP transport is used in EVERY environment;
   * without it, development and test fall back to a logging stub that delivers
   * nothing, and staging/production refuse to boot (below) - a control plane
   * that comes up healthy with signup, password reset and invitations silently
   * dead is the failure this exists to prevent.
   *
   * The scheme check is not redundant: `z.string().url()` accepts `host:1025`
   * as a URL with scheme `host`.
   */
  SMTP_URL: blankAsUnset(
    z
      .string()
      .url()
      .refine(
        (v) => /^smtps?:\/\//i.test(v),
        'SMTP_URL must start with smtp:// or smtps:// (e.g. smtp://user:pass@mail.example.com:587)',
      )
      .optional(),
  ),
  /**
   * The From header: `Display Name <address>` (or a bare address). Required
   * whenever SMTP_URL is set. The display name is also the product name the
   * messages use in their subject and body.
   */
  MAIL_FROM: blankAsUnset(
    z
      .string()
      .refine(
        (v) => parseMailbox(v) !== null,
        'MAIL_FROM must be a mailbox such as "Hookubit <no-reply@example.com>" or no-reply@example.com',
      )
      .optional(),
  ),
}).superRefine((env, ctx) => {
  if (env.SMTP_URL && !env.MAIL_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAIL_FROM'],
      message: 'MAIL_FROM is required when SMTP_URL is set - the transport needs a sender address',
    });
  }
  // The same rule the development stubs enforce in their constructors, moved
  // to where every other "refuses to boot" decision lives so the failure is
  // one line naming the variable rather than a DI stack trace.
  if (!env.SMTP_URL && (env.APP_ENV === 'staging' || env.APP_ENV === 'production')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_URL'],
      message:
        `SMTP_URL is required when APP_ENV=${env.APP_ENV}: without a mail transport, registration, ` +
        'email verification, password reset and member invitations would silently deliver nothing',
    });
  }
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
