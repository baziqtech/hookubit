/**
 * The write-side validation the mock has to reproduce, kept out of the router.
 *
 * The mock IS the contract until `generate:api` runs, and a mock that only
 * implements the happy path is worse than none: every rejection the UI has to
 * render — an SSRF-shaped URL, a reserved header, a slug collision, a body
 * carrying an immutable field — is then first exercised in production.
 *
 * These mirror, in the same words:
 *
 *   `apps/control-api/src/endpoints/endpoint-url.ts`      (the SSRF mirror)
 *   `apps/control-api/src/endpoints/endpoint-headers.ts`  (reserved headers)
 *   `apps/control-api/src/endpoints/endpoint-limits.ts`   (the numeric bounds)
 *
 * They are strict subsets. The real dial-time guard in the Go data plane is
 * what actually stops SSRF; this decides only what is decidable without DNS.
 */
import type { Role } from '../../types/api';
import {
  ENDPOINT_LIMITS,
  MAX_CUSTOM_HEADERS,
  MAX_ENDPOINT_DESCRIPTION_LENGTH,
  MAX_ENDPOINT_NAME_LENGTH,
  MAX_ENDPOINT_URL_LENGTH,
  MAX_PAYLOAD_FILTER_BYTES,
  MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH,
  MAX_SUBSCRIPTION_NAME_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  PROJECT_SLUG_MAX_LENGTH,
  RESERVED_HEADER_NAMES,
  RESERVED_HEADER_PREFIX,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from '../../types/api';
import { rejectEventTypes } from '../../features/subscriptions/event-types';
import {
  MAX_RETRY_POLICY_NAME_LENGTH,
  RATE_LIMIT_LIMITS,
  RATE_LIMIT_SCOPES,
  RETRY_POLICY_LIMITS,
  RETRY_STRATEGIES,
} from '../../types/api';

/** `"<property>: <reason>"`, the exact shape class-validator's messages take. */
export type Rejections = string[];

const METADATA_LITERALS = ['169.254.169.254', '100.100.100.200'];

function ipv4Bytes(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return bytes;
}

/** Why a literal address is unreachable from the platform, or null. */
function classifyLiteral(host: string): string | null {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback address';
  if (host === '::1' || host === '[::1]') return 'loopback address';
  if (METADATA_LITERALS.includes(host)) return 'cloud instance metadata address';

  const b = ipv4Bytes(host);
  if (!b) return null;
  if (b[0] === 169 && b[1] === 254) return 'link-local address';
  if (b[0] === 127) return 'loopback address';
  if (b[0] === 10) return 'private address';
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return 'private address';
  if (b[0] === 192 && b[1] === 168) return 'private address';
  if (b.every((byte) => byte === 0)) return 'unspecified address';
  return null;
}

/**
 * Returns why the URL is unusable, or null.
 *
 * The wording tracks `rejectEndpointUrl` so the message an operator reads at
 * save time and the one they read in a delivery error are the same sentence.
 */
export function rejectEndpointUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'a URL is required';
  const text = raw.trim();
  if (text.length > MAX_ENDPOINT_URL_LENGTH) {
    return `URL is longer than ${MAX_ENDPOINT_URL_LENGTH} characters`;
  }
  if (/\s/.test(text)) return 'URL contains whitespace or control characters';

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'malformed URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `scheme ${url.protocol.replace(':', '')} is not permitted; use http or https`;
  }
  // Credentials in a URL end up in delivery logs, in this UI and in support
  // threads. The Go guard refuses them for the same reason.
  if (url.username || url.password) return 'credentials in URL are not permitted';

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'URL has no host';
  return classifyLiteral(host);
}

/** RFC 9110 field-name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function rejectCustomHeaders(headers: unknown): string | null {
  if (headers === undefined || headers === null) return null;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    return 'custom_headers must be an object of string values';
  }

  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return `at most ${MAX_CUSTOM_HEADERS} custom headers are allowed`;
  }

  const seen = new Set<string>();
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) {
      return `"${name}": header name contains characters that are not allowed`;
    }
    if (lower.startsWith(RESERVED_HEADER_PREFIX) || RESERVED_HEADER_NAMES.includes(lower)) {
      return (
        `"${name}": this header is reserved by the platform and cannot be overridden. ` +
        'Webhook-* carries the signature and delivery identity; Authorization, Host, ' +
        'Content-Length and Transfer-Encoding frame or authenticate the request itself.'
      );
    }
    if (seen.has(lower)) return `"${name}": duplicate header name (names are case-insensitive)`;
    seen.add(lower);
    if (typeof value !== 'string') return `"${name}": header value must be a string`;
  }
  return null;
}

function rejectInteger(
  value: unknown,
  property: string,
  bounds: { min: number; max: number },
): string | null {
  if (!Number.isInteger(value)) return `${property}: must be an integer`;
  const numeric = value as number;
  if (numeric < bounds.min) return `${property}: must not be less than ${bounds.min}`;
  if (numeric > bounds.max) return `${property}: must not be greater than ${bounds.max}`;
  return null;
}

/**
 * `UpdateEndpointDto` — `PartialType(CreateEndpointDto)`, plus the whitelist.
 *
 * An unknown key is a 400 and not a silent drop, because the pipe runs with
 * `forbidNonWhitelisted`. `status` is the one that matters: it is not in the
 * DTO, so a client trying to enable an endpoint through a PATCH is told so
 * rather than getting a 200 that changed nothing.
 */
const ENDPOINT_WRITABLE = [
  'name',
  'url',
  'description',
  'timeout_ms',
  'max_concurrency',
  'rate_limit',
  'rate_limit_window_seconds',
  'retry_policy_id',
  'custom_headers',
];

export function rejectEndpointPatch(body: Record<string, unknown>): Rejections {
  const rejections: Rejections = [];

  for (const key of Object.keys(body)) {
    if (ENDPOINT_WRITABLE.includes(key)) continue;
    rejections.push(
      key === 'status'
        ? 'status: property status should not exist. Enabling, disabling and deleting have their own routes, each with a precondition a PATCH would walk past.'
        : `${key}: property ${key} should not exist`,
    );
  }

  if ('name' in body) {
    const name = body.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_ENDPOINT_NAME_LENGTH) {
      rejections.push(`name: must be between 1 and ${MAX_ENDPOINT_NAME_LENGTH} characters`);
    }
  }
  if ('url' in body) {
    const reason = rejectEndpointUrl(body.url);
    if (reason) rejections.push(`url: ${reason}`);
  }
  if ('description' in body && body.description !== null) {
    const description = body.description;
    if (typeof description !== 'string' || description.length > MAX_ENDPOINT_DESCRIPTION_LENGTH) {
      rejections.push(`description: must be at most ${MAX_ENDPOINT_DESCRIPTION_LENGTH} characters`);
    }
  }
  if ('timeout_ms' in body) {
    const reason = rejectInteger(body.timeout_ms, 'timeout_ms', ENDPOINT_LIMITS.timeout_ms);
    if (reason) rejections.push(reason);
  }
  if ('max_concurrency' in body) {
    const reason = rejectInteger(
      body.max_concurrency,
      'max_concurrency',
      ENDPOINT_LIMITS.max_concurrency,
    );
    if (reason) rejections.push(reason);
  }
  // Null is a legal value and means "no per-endpoint limit"; it is not the same
  // request as omitting the key.
  if ('rate_limit' in body && body.rate_limit !== null) {
    const reason = rejectInteger(body.rate_limit, 'rate_limit', ENDPOINT_LIMITS.rate_limit);
    if (reason) rejections.push(reason);
  }
  if ('rate_limit_window_seconds' in body) {
    const reason = rejectInteger(
      body.rate_limit_window_seconds,
      'rate_limit_window_seconds',
      ENDPOINT_LIMITS.rate_limit_window_seconds,
    );
    if (reason) rejections.push(reason);
  }
  if ('retry_policy_id' in body && body.retry_policy_id !== null) {
    const id = body.retry_policy_id;
    if (typeof id !== 'string' || id.length > 64) {
      rejections.push('retry_policy_id: must be at most 64 characters');
    }
  }
  if ('custom_headers' in body) {
    const reason = rejectCustomHeaders(body.custom_headers);
    if (reason) rejections.push(`custom_headers: ${reason}`);
  }

  return rejections;
}

/**
 * `UpdateProjectDto` / `UpdateOrganizationDto` — name and slug, and nothing
 * else.
 *
 * `environment` gets its own sentence rather than the generic whitelist one,
 * because `ProjectsService.update` checks for the key explicitly so the caller
 * learns WHY it is refused instead of reading the refusal as a typo.
 */
export function rejectIdentityPatch(
  body: Record<string, unknown>,
  options: { nameMin: number; nameMax: number; slugMax: number; kind: 'project' | 'organization' },
): Rejections {
  const rejections: Rejections = [];

  for (const key of Object.keys(body)) {
    if (key === 'name' || key === 'slug') continue;
    if (key === 'environment' && options.kind === 'project') {
      rejections.push(
        'environment: a project’s environment cannot be changed. It scopes every API key and endpoint underneath the project, so switching it would silently re-point live traffic. Create a second project instead.',
      );
      continue;
    }
    if (key === 'status') {
      rejections.push(
        `status: property status should not exist. Deleting a ${options.kind} is its own route so it is audited as a deletion rather than as an edit.`,
      );
      continue;
    }
    rejections.push(`${key}: property ${key} should not exist`);
  }

  if ('name' in body) {
    const name = body.name;
    if (
      typeof name !== 'string' ||
      name.length < options.nameMin ||
      name.length > options.nameMax
    ) {
      rejections.push(
        `name: must be between ${options.nameMin} and ${options.nameMax} characters`,
      );
    }
  }
  if ('slug' in body) {
    const slug = body.slug;
    if (typeof slug !== 'string' || slug.length < 2 || slug.length > options.slugMax) {
      rejections.push(`slug: must be between 2 and ${options.slugMax} characters`);
    } else if (!SLUG_PATTERN.test(slug)) {
      rejections.push('slug: must be lowercase letters, digits and single dashes');
    }
  }

  return rejections;
}

/* ── Subscriptions ────────────────────────────────────────────────────────── */

/**
 * `payload_filter`, as far as the SHAPE goes.
 *
 * The full predicate grammar in control-api `payload-filter.ts` is not
 * mirrored here — see `features/subscriptions/payload-filter.ts` for why. What
 * the mock reproduces is every refusal the form can reach: not an object, the
 * empty object, over the byte ceiling, and a `$`-prefixed key that is not one
 * of the three logical operators. Each is worded as the server words it and
 * prefixed `payload_filter: ` the way `PayloadFilterConstraint.defaultMessage`
 * prefixes it.
 */
export function rejectPayloadFilter(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'payload_filter must be a JSON object, or null for no filter';
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return 'payload_filter: is an empty object, which would match every payload. Omit payload_filter (or send null) if you do not want to filter on the body';
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > MAX_PAYLOAD_FILTER_BYTES) {
    return `payload_filter is ${bytes} bytes; the maximum is ${MAX_PAYLOAD_FILTER_BYTES}`;
  }
  for (const [key] of entries) {
    if (key.startsWith('$') && !['$and', '$or', '$not'].includes(key)) {
      return `payload_filter.${key}: is not a supported operator. Logical: $and, $or, $not. Anything else here is read as a field path, and a field path may not begin with "$"`;
    }
  }
  return null;
}

const SUBSCRIPTION_CREATE_FIELDS = ['name', 'endpoint_id', 'event_types', 'payload_filter', 'enabled'];
const SUBSCRIPTION_UPDATE_FIELDS = ['name', 'endpoint_id', 'event_types', 'payload_filter'];

function rejectSubscriptionName(name: unknown): string | null {
  if (name === null) return null;
  if (typeof name !== 'string') return 'name: must be a string';
  if (name.length > MAX_SUBSCRIPTION_NAME_LENGTH) {
    return `name: must be shorter than or equal to ${MAX_SUBSCRIPTION_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * `CreateSubscriptionDto`.
 *
 * The event-type rejection is `rejectEventTypes` from the dashboard's own
 * mirror — ONE copy of the server's words, shared by the form and the mock —
 * and it is emitted WITHOUT a `property:` prefix, because that is what
 * `EventTypesConstraint.defaultMessage` does: its message is the reason, and
 * the reason begins with `event_types`. The form routes it by that prefix, and
 * a mock that added a prefix would let that routing rot.
 */
export function rejectSubscriptionCreate(body: Record<string, unknown>): Rejections {
  const rejections: Rejections = [];
  for (const key of Object.keys(body)) {
    if (!SUBSCRIPTION_CREATE_FIELDS.includes(key)) {
      rejections.push(`${key}: property ${key} should not exist`);
    }
  }
  if ('name' in body) {
    const reason = rejectSubscriptionName(body.name);
    if (reason) rejections.push(reason);
  }
  if (typeof body.endpoint_id !== 'string' || body.endpoint_id.length === 0) {
    rejections.push('endpoint_id: must be a string');
  } else if (body.endpoint_id.length > 64) {
    rejections.push('endpoint_id: must be shorter than or equal to 64 characters');
  }
  const eventTypes = rejectEventTypes(body.event_types);
  if (eventTypes) rejections.push(eventTypes);
  const filter = rejectPayloadFilter(body.payload_filter);
  if (filter) rejections.push(filter);
  if ('enabled' in body && typeof body.enabled !== 'boolean') {
    rejections.push('enabled: must be a boolean value');
  }
  return rejections;
}

/**
 * `UpdateSubscriptionDto` — the same fields minus `enabled`, which has its own
 * routes and gets its own sentence rather than the generic whitelist one.
 * `event_types: null` reaches the validator (the real `@IsOptional()` skips
 * null, and the service asserts it again) and is refused as "must be an
 * array"; `name: null` and `payload_filter: null` CLEAR those fields.
 */
export function rejectSubscriptionPatch(body: Record<string, unknown>): Rejections {
  const rejections: Rejections = [];
  for (const key of Object.keys(body)) {
    if (SUBSCRIPTION_UPDATE_FIELDS.includes(key)) continue;
    rejections.push(
      key === 'enabled'
        ? 'enabled: property enabled should not exist. Enabling and disabling have their own routes so that pausing a route is a separately audited act.'
        : `${key}: property ${key} should not exist`,
    );
  }
  if ('name' in body) {
    const reason = rejectSubscriptionName(body.name);
    if (reason) rejections.push(reason);
  }
  if ('endpoint_id' in body) {
    if (typeof body.endpoint_id !== 'string' || body.endpoint_id.length === 0) {
      rejections.push('endpoint_id: must be a string');
    }
  }
  if ('event_types' in body) {
    const reason = rejectEventTypes(body.event_types);
    if (reason) rejections.push(reason);
  }
  if ('payload_filter' in body) {
    const reason = rejectPayloadFilter(body.payload_filter);
    if (reason) rejections.push(reason);
  }
  return rejections;
}

/** `DisableSubscriptionDto.reason` — optional, `@MaxLength(200)`. */
export function rejectDisableReason(body: unknown): Rejections {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (reason === undefined) return [];
  if (typeof reason !== 'string' || reason.length > MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH) {
    return [`reason: must be a string of at most ${MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH} characters`];
  }
  return [];
}

/* ── Projects ─────────────────────────────────────────────────────────────── */

/**
 * `slugFromName` from control-api `src/projects/slug.ts`, verbatim. A DERIVED
 * slug is normalised (there is nothing for the caller to disagree with yet);
 * a SUPPLIED one is validated and never rewritten.
 */
export function slugFromName(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  if (slug.length < SLUG_MIN_LENGTH || !SLUG_PATTERN.test(slug)) return null;
  return slug;
}

/** `CreateProjectDto` — name required, slug optional, environment `test | live`. */
export function rejectProjectCreate(body: Record<string, unknown>): Rejections {
  const rejections: Rejections = [];
  for (const key of Object.keys(body)) {
    if (key === 'name' || key === 'slug' || key === 'environment') continue;
    rejections.push(`${key}: property ${key} should not exist`);
  }
  const name = body.name;
  if (
    typeof name !== 'string' ||
    name.length < PROJECT_NAME_MIN_LENGTH ||
    name.length > PROJECT_NAME_MAX_LENGTH
  ) {
    rejections.push(
      `name: must be between ${PROJECT_NAME_MIN_LENGTH} and ${PROJECT_NAME_MAX_LENGTH} characters`,
    );
  }
  if (body.slug !== undefined) {
    const slug = body.slug;
    if (typeof slug !== 'string' || slug.length < SLUG_MIN_LENGTH || slug.length > PROJECT_SLUG_MAX_LENGTH) {
      rejections.push(`slug: must be between ${SLUG_MIN_LENGTH} and ${PROJECT_SLUG_MAX_LENGTH} characters`);
    } else if (!SLUG_PATTERN.test(slug)) {
      rejections.push('slug: slug must be lowercase alphanumeric segments separated by single hyphens');
    }
  }
  if (body.environment !== undefined && body.environment !== 'test' && body.environment !== 'live') {
    rejections.push('environment: must be one of the following values: test, live');
  }
  return rejections;
}

/* ── Members — the role lattice ───────────────────────────────────────────── */

/** `ROLE_RANK` in control-api `src/authz/permissions.ts`. */
const ROLE_RANK: Record<Role, number> = { owner: 40, admin: 30, developer: 20, viewer: 10, billing: 10 };
const MEMBER_ROLES: readonly Role[] = ['owner', 'admin', 'developer', 'viewer', 'billing'];

export function isMemberRole(value: unknown): value is Role {
  return typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value);
}

const holdsMembersWrite = (role: Role) => role === 'owner' || role === 'admin';
const mayAssignRole = (actor: Role, target: Role) =>
  holdsMembersWrite(actor) && ROLE_RANK[target] <= ROLE_RANK[actor];

export interface MemberRefusal {
  status: 403 | 409;
  code: 'forbidden' | 'conflict';
  message: string;
}

/**
 * `assertRoleChangeAllowed` / `assertMemberRemovalAllowed` /
 * `assertOwnerSurvives`, sentence for sentence. `nextRole: null` is a removal.
 *
 * Note that the last-owner 409 is a RACE guard on the real server: an actor
 * with `members.write` is an owner or an admin, an admin cannot touch an owner,
 * and an owner demoting another owner always counts at least two. It is
 * reachable through a single request only when the owner count the
 * transaction reads disagrees with the caller's own role — which is exactly
 * what SERIALIZABLE exists to catch. It is mirrored here so the sentence and
 * the status are pinned, not because the mock can be driven into it.
 */
export function rejectMemberChange(change: {
  actorRole: Role;
  actorMembershipId: string;
  targetMembershipId: string;
  currentRole: Role;
  nextRole: Role | null;
  ownerCount: number;
}): MemberRefusal | null {
  const removal = change.nextRole === null;
  if (!holdsMembersWrite(change.actorRole)) {
    return {
      status: 403,
      code: 'forbidden',
      message: removal ? 'You may not remove members.' : 'You may not change member roles.',
    };
  }
  if (change.actorMembershipId === change.targetMembershipId) {
    return {
      status: 403,
      code: 'forbidden',
      message: removal
        ? 'You cannot remove your own membership. Ask another owner or admin to do it.'
        : 'You cannot change your own role. Ask another owner or admin to do it.',
    };
  }
  if (change.nextRole !== null && !mayAssignRole(change.actorRole, change.nextRole)) {
    return {
      status: 403,
      code: 'forbidden',
      message: `You may not assign the role "${change.nextRole}".`,
    };
  }
  if (!mayAssignRole(change.actorRole, change.currentRole)) {
    return {
      status: 403,
      code: 'forbidden',
      message: removal
        ? `You may not remove an ${change.currentRole}.`
        : `You may not change the role of an ${change.currentRole}.`,
    };
  }
  if (change.currentRole === 'owner' && change.nextRole !== 'owner' && change.ownerCount <= 1) {
    return {
      status: 409,
      code: 'conflict',
      message: 'An organization must always have at least one owner. Promote another member first.',
    };
  }
  return null;
}

/* ── Retry policies and rate limits ───────────────────────────────────────── */

/**
 * The per-field edge of `CreateRetryPolicyDto` / `UpdateRetryPolicyDto`, in
 * class-validator's words. The CROSS-field rules are not here: the server
 * raises those from the service as one sentence with `details.field`, and the
 * mock does the same in `server.ts` using the dashboard's own mirror
 * (`features/retry-policies/retry-policy-rules.ts`), so there is exactly one
 * copy of those sentences on the client side.
 */
const RETRY_POLICY_WRITABLE = [
  'name',
  'is_default',
  'strategy',
  'max_attempts',
  'initial_delay_ms',
  'max_delay_ms',
  'multiplier',
  'jitter_ratio',
  'max_retry_duration_ms',
];

function rejectFloat(
  value: unknown,
  property: string,
  bounds: { min: number; max: number },
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${property}: must be a number conforming to the specified constraints`;
  }
  if (value < bounds.min) return `${property}: must not be less than ${bounds.min}`;
  if (value > bounds.max) return `${property}: must not be greater than ${bounds.max}`;
  return null;
}

export function rejectRetryPolicyBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Rejections {
  const rejections: Rejections = [];

  for (const key of Object.keys(body)) {
    if (key === 'is_default' && mode === 'update') {
      // `UpdateRetryPolicyDto` omits it: the default is moved with
      // POST …/default so the clear and the set share one transaction.
      rejections.push(
        'is_default: property is_default should not exist. The project default is moved with POST …/default, so the clear of the old one and the set of the new one happen in a single transaction.',
      );
      continue;
    }
    if (RETRY_POLICY_WRITABLE.includes(key)) continue;
    rejections.push(`${key}: property ${key} should not exist`);
  }

  if (mode === 'create' || 'name' in body) {
    const name = body.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_RETRY_POLICY_NAME_LENGTH) {
      rejections.push(`name: must be between 1 and ${MAX_RETRY_POLICY_NAME_LENGTH} characters`);
    }
  }
  if ('is_default' in body && mode === 'create' && typeof body.is_default !== 'boolean') {
    rejections.push('is_default: must be a boolean value');
  }
  if ('strategy' in body && !(RETRY_STRATEGIES as readonly unknown[]).includes(body.strategy)) {
    rejections.push(
      `strategy: must be one of the following values: ${RETRY_STRATEGIES.join(', ')}`,
    );
  }
  for (const field of [
    'max_attempts',
    'initial_delay_ms',
    'max_delay_ms',
    'max_retry_duration_ms',
  ] as const) {
    if (!(field in body)) continue;
    const reason = rejectInteger(body[field], field, RETRY_POLICY_LIMITS[field]);
    if (reason) rejections.push(reason);
  }
  for (const field of ['multiplier', 'jitter_ratio'] as const) {
    if (!(field in body)) continue;
    const reason = rejectFloat(body[field], field, RETRY_POLICY_LIMITS[field]);
    if (reason) rejections.push(reason);
  }

  return rejections;
}

/**
 * `CreateRateLimitDto` / `UpdateRateLimitDto`. `resource_id: null` and
 * `burst: null` are MEANINGFUL ("every resource in this scope", "the same as
 * limit") and pass validation; they are not the same request as omitting the
 * key. `burst >= limit` is cross-field and lives in `server.ts`.
 */
const RATE_LIMIT_WRITABLE = ['scope', 'resource_id', 'limit', 'window_seconds', 'burst'];

export function rejectRateLimitBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Rejections {
  const rejections: Rejections = [];

  for (const key of Object.keys(body)) {
    if (RATE_LIMIT_WRITABLE.includes(key)) continue;
    rejections.push(`${key}: property ${key} should not exist`);
  }

  if (mode === 'create' || 'scope' in body) {
    if (!(RATE_LIMIT_SCOPES as readonly unknown[]).includes(body.scope)) {
      rejections.push(`scope: must be one of the following values: ${RATE_LIMIT_SCOPES.join(', ')}`);
    }
  }
  if ('resource_id' in body && body.resource_id !== null) {
    const id = body.resource_id;
    if (typeof id !== 'string' || id.length > 64) {
      rejections.push('resource_id: must be shorter than or equal to 64 characters');
    }
  }
  if (mode === 'create' || 'limit' in body) {
    const reason = rejectInteger(body.limit, 'limit', RATE_LIMIT_LIMITS.limit);
    if (reason) rejections.push(reason);
  }
  if ('window_seconds' in body) {
    const reason = rejectInteger(body.window_seconds, 'window_seconds', RATE_LIMIT_LIMITS.window_seconds);
    if (reason) rejections.push(reason);
  }
  if ('burst' in body && body.burst !== null) {
    const reason = rejectInteger(body.burst, 'burst', RATE_LIMIT_LIMITS.burst);
    if (reason) rejections.push(reason);
  }

  return rejections;
}
