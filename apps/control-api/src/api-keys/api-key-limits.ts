import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Bounds on how fast, and how many, API keys a project may hold.
 *
 * Issuing a credential was unbounded: `POST /v1/projects/:projectId/api-keys` is
 * authenticated, cheap, and every call mints a live credential against the
 * ingest path. Unbounded issuance is not just a row-count problem - it is an
 * unbounded set of things that have to be revoked when something goes wrong, and
 * the operator surface ("what can currently authenticate as this project?") is
 * exactly what ARCHITECTURE.md calls the part people actually pay for.
 *
 * Rate and total are separate limits: see `projects/project-limits.ts` for why
 * the throttle is a constant and the ceiling is read from configuration.
 */
export const API_KEY_CREATE_THROTTLE = {
  name: 'api-keys.create',
  /**
   * Issuing a key is a deliberate, rare act - a human does it once per
   * integration. Ten a minute is generous for that and instant for a loop.
   */
  limit: 10,
  windowMs: 60_000,
} as const;

/**
 * Revocation is limited far more loosely than issuance, and on purpose.
 *
 * It is the operation an operator reaches for under pressure, often from a
 * script with retries, and it is idempotent. A throttle that made "revoke every
 * key in this project right now" fail partway would be a limit that causes the
 * incident it was added to contain. This is here to bound an abusive loop, not
 * to pace an operator.
 */
export const API_KEY_REVOKE_THROTTLE = {
  name: 'api-keys.revoke',
  limit: 60,
  windowMs: 60_000,
} as const;

/** `MAX_API_KEYS_PER_PROJECT`, clamped. */
export const API_KEYS_PER_PROJECT = {
  env: 'MAX_API_KEYS_PER_PROJECT',
  /**
   * Fifty live keys per project. Rotation needs two at a time and a busy
   * integration a handful; fifty is well past any of that.
   */
  default: 50,
  min: 1,
  max: 1_000,
} as const;

const logger = new Logger('ApiKeyLimits');

/**
 * The configured ceiling, or the default. Clamped, and never fatal: an
 * unparsable value warns and falls back rather than refusing to boot.
 */
export function maxApiKeysPerProject(config: ConfigService): number {
  const raw = config.get<string | number>(API_KEYS_PER_PROJECT.env);
  const bounds = API_KEYS_PER_PROJECT;
  if (raw === undefined || raw === null || raw === '') return bounds.default;

  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(`${bounds.env}="${String(raw)}" is not a number; using ${bounds.default}.`);
    return bounds.default;
  }
  const floored = Math.floor(parsed);
  if (floored < bounds.min || floored > bounds.max) {
    const clamped = Math.min(Math.max(floored, bounds.min), bounds.max);
    logger.warn(`${bounds.env}=${floored} is outside [${bounds.min}, ${bounds.max}]; using ${clamped}.`);
    return clamped;
  }
  return floored;
}
