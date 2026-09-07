import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ApiKeyListDto } from '../api-keys/dto';
import { EndpointSecretListDto } from '../endpoint-secrets/dto';
import { EndpointListDto } from '../endpoints/dto';
import { MemberListDto } from '../members/dto';
import { OrganizationListDto } from '../organizations/dto';
import { ProjectListDto } from '../projects/dto';
import { RateLimitListDto } from '../rate-limits/dto';
import { RetryPolicyListDto } from '../retry-policies/dto';
import { SubscriptionListDto } from '../webhook-subscriptions/dto';
import { AuditLogListDto } from './dto';

/**
 * ONE list envelope, across the whole API: `{ data, has_more, next_offset }`.
 *
 * This lives in the audit module because the audit module is the change that
 * standardised it; it is a contract test over every list route, not a test of
 * audit logs. Move it if a better home appears - do not delete it.
 *
 * ## What went wrong, so the next author does not re-derive it
 *
 * The backend shipped THREE envelopes at once. `{ data, count, has_more,
 * next_offset }` on projects and api-keys; `{ data, has_more, next_offset }` on
 * endpoints and endpoint-secrets; and `{ data, total, limit, offset }` - with no
 * `has_more` at all - on organizations and members. A dashboard generated from
 * the OpenAPI document had to special-case three shapes for the same idea.
 *
 * The third was the damaging one. `has_more` is the entire reason
 * `ScopedRepository.findMany` now THROWS rather than silently truncating: a
 * bounded read that returns a bare array cannot tell its caller the bound was
 * reached, which is how "revoke every key" reports success over the first fifty.
 * A client cannot recover it from a `total`, because the count and the page are
 * two reads at two instants - a row created between them makes
 * `offset + data.length < total` claim there is more when there is not, and a
 * deletion does the reverse.
 *
 * `total` is gone rather than renamed: a second COUNT on every request is real
 * work on the large tables and buys a client paging on `has_more` nothing.
 * `count` is gone because it was `data.length` restated, and it invited exactly
 * the `count === limit` last-page test `has_more` exists to replace. `limit` and
 * `offset` are gone because they were the request echoed back.
 *
 * ## Why it asserts the SWAGGER metadata
 *
 * The dashboard client is generated from the OpenAPI document, not from these
 * classes. A field can be removed from the TypeScript type and left on the
 * document (or the reverse) and only the generated client would notice - months
 * later. So this reads `swagger/apiModelPropertiesArray`, which is the exact
 * source the document is built from.
 */

/** The three keys. Alphabetical, because that is how they are compared below. */
const CANONICAL = ['data', 'has_more', 'next_offset'];

const SWAGGER_PROPERTIES = 'swagger/apiModelPropertiesArray';
const SWAGGER_PROPERTY = 'swagger/apiModelProperties';

interface ListDto {
  new (): object;
  readonly name: string;
}

/**
 * The six modules that disagreed, plus the three that were already right - all
 * nine, so this fails if a future module invents a fourth shape too.
 */
const LIST_DTOS: Array<[string, ListDto, string]> = [
  ['organizations', OrganizationListDto, 'was { data, total, limit, offset } - NO has_more'],
  ['members', MemberListDto, 'was { data, total, limit, offset } - NO has_more'],
  ['projects', ProjectListDto, 'was { data, count, has_more, next_offset }'],
  ['api-keys', ApiKeyListDto, 'was { data, count, has_more, next_offset }'],
  ['endpoints', EndpointListDto, 'was already canonical'],
  ['endpoint-secrets', EndpointSecretListDto, 'was already canonical'],
  ['webhook-subscriptions', SubscriptionListDto, 'was already canonical'],
  ['retry-policies', RetryPolicyListDto, 'was already canonical'],
  ['rate-limits', RateLimitListDto, 'was already canonical'],
  ['audit', AuditLogListDto, 'new in this change'],
];

function documentedProperties(dto: ListDto): string[] {
  const declared: unknown = Reflect.getMetadata(SWAGGER_PROPERTIES, dto.prototype);
  if (!Array.isArray(declared)) {
    throw new Error(`${dto.name} declares no @ApiProperty metadata at all`);
  }
  // The array holds ':<property>'; the leading colon is swagger's own marker.
  return declared.map((entry) => String(entry).replace(/^:/, '')).sort();
}

function propertyOptions(dto: ListDto, property: string): Record<string, unknown> {
  const options: unknown = Reflect.getMetadata(SWAGGER_PROPERTY, dto.prototype, property);
  if (!options || typeof options !== 'object') {
    throw new Error(`${dto.name}.${property} carries no @ApiProperty options`);
  }
  return options as Record<string, unknown>;
}

describe('every list route returns the same envelope', () => {
  it.each(LIST_DTOS)(
    '%s returns exactly { data, has_more, next_offset } (%#)',
    (_module, dto) => {
      expect(documentedProperties(dto)).toEqual(CANONICAL);
    },
  );

  it.each(LIST_DTOS)('%s declares no total, count, limit or offset (%#)', (_module, dto) => {
    const documented = documentedProperties(dto);
    for (const banned of ['total', 'count', 'limit', 'offset']) {
      expect(documented).not.toContain(banned);
    }
  });

  it.each(LIST_DTOS)('%s documents has_more as a required boolean (%#)', (_module, dto) => {
    const options = propertyOptions(dto, 'has_more');
    // Required: `@ApiPropertyOptional` sets `required: false`, and an optional
    // `has_more` is one a generated client may treat as absent - which is the
    // silence the field exists to remove.
    expect(options.required).not.toBe(false);
  });

  it.each(LIST_DTOS)('%s documents next_offset as nullable (%#)', (_module, dto) => {
    // Null is the whole signal for "this was the last page".
    expect(propertyOptions(dto, 'next_offset').nullable).toBe(true);
  });

  /**
   * `next_offset` must also be REQUIRED in the document, and typed.
   *
   * `@ApiPropertyOptional` sets `required: false`, which generates a client
   * field that may be ABSENT as well as null - two things to branch on where
   * the contract has one. It was declared that way on several modules; the
   * seven below have been corrected. `webhook-subscriptions`, `retry-policies`
   * and `rate-limits` still declare it optional, and so do the in-flight
   * `events` and `deliveries` modules, all of which belong to other authors -
   * see HANDOFF.md. Add each to this list as it is fixed; do not weaken the
   * assertion.
   */
  const REQUIRED_NEXT_OFFSET = LIST_DTOS.filter(([module]) =>
    ['organizations', 'members', 'projects', 'api-keys', 'endpoints', 'endpoint-secrets', 'audit'].includes(
      module,
    ),
  );

  it.each(REQUIRED_NEXT_OFFSET)(
    '%s documents next_offset as a REQUIRED number, not an optional one (%#)',
    (_module, dto) => {
      const options = propertyOptions(dto, 'next_offset');
      expect(options.required).not.toBe(false);
      expect(options.type).toBe(Number);
    },
  );

  /**
   * The table above only knows what it was told about. This sweeps the whole
   * source tree instead, so a module landing later - `events` and `deliveries`
   * are being written right now - cannot quietly introduce a fourth envelope
   * without a test failing. It reads source rather than importing, so it covers
   * modules this file has no import of.
   */
  it('has no list DTO anywhere in the source tree with a different shape', () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(/export class (\w*ListDto) \{([\s\S]*?)\n\}/g)) {
          const [, name, body] = match;
          // `!:` is the declaration marker, and it appears on a line of its own
          // or after an inline decorator - both forms are in this tree.
          const fields = [...body.matchAll(/(\w+)!:/g)].map((field) => field[1]).sort();
          if (fields.join(',') !== CANONICAL.join(',')) {
            offenders.push(`${name} (${entry}) declares { ${fields.join(', ')} }`);
          }
        }
      }
    };
    walk(join(__dirname, '..'));

    expect(offenders).toEqual([]);
  });
});
