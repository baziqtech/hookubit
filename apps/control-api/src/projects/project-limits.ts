import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Bounds on how fast, and how many, projects a tenant may create.
 *
 * `POST /v1/organizations/:orgId/projects` was unbounded in both dimensions:
 * authenticated, cheap, and it writes a row plus an audit entry every time. A
 * developer with a loop - or a leaked session - could put an unbounded number of
 * rows into `projects`, and every one of them widens the blast radius of the
 * things that hang off a project (endpoints, keys, the delivery ledger).
 *
 * Two independent limits, because they answer different questions:
 *
 * - The THROTTLE bounds the RATE. It is per source address and per window, so a
 *   burst is refused with 429 and `Retry-After` rather than absorbed. It is a
 *   compile-time constant because `@Throttle` is decorator metadata, evaluated
 *   when the class is defined - which is before `ConfigModule` has read a
 *   `.env` file, so an env-driven value there would silently be the default.
 * - The CEILING bounds the TOTAL. It is read through `ConfigService` at call
 *   time, so an operator can raise it for a large customer without a deploy.
 */
export const PROJECT_CREATE_THROTTLE = {
  name: 'projects.create',
  /**
   * Twenty creates a minute per address. A human creating projects by hand
   * never approaches this; a runaway script hits it in under three seconds.
   */
  limit: 20,
  windowMs: 60_000,
} as const;

/** `MAX_PROJECTS_PER_ORGANIZATION`, clamped. */
export const PROJECTS_PER_ORGANIZATION = {
  env: 'MAX_PROJECTS_PER_ORGANIZATION',
  /**
   * A hundred live projects is far past any real internal fan-out topology and
   * far short of a number that hurts a listing, so it bites only on automation
   * that has gone wrong.
   */
  default: 100,
  min: 1,
  max: 10_000,
} as const;

const logger = new Logger('ProjectLimits');

/**
 * The configured ceiling, or the default.
 *
 * Clamped rather than trusted: `MAX_PROJECTS_PER_ORGANIZATION=0` would lock a
 * tenant out of its own product and `=1e9` would be the same as having no limit,
 * and both are one typo away in a Helm values file. Anything unparsable falls
 * back to the default with a warning - refusing to boot over a rate ceiling
 * would be a worse failure than running with the documented one.
 */
export function maxProjectsPerOrganization(config: ConfigService): number {
  return clamp(config.get<string | number>(PROJECTS_PER_ORGANIZATION.env), PROJECTS_PER_ORGANIZATION);
}

function clamp(
  raw: string | number | undefined,
  bounds: { env: string; default: number; min: number; max: number },
): number {
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
