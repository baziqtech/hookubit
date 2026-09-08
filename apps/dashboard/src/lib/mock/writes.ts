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
import {
  ENDPOINT_LIMITS,
  MAX_CUSTOM_HEADERS,
  MAX_ENDPOINT_DESCRIPTION_LENGTH,
  MAX_ENDPOINT_NAME_LENGTH,
  MAX_ENDPOINT_URL_LENGTH,
  RESERVED_HEADER_NAMES,
  RESERVED_HEADER_PREFIX,
  SLUG_PATTERN,
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
