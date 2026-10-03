import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as analytics from '../analytics/dto';
import * as apiKeys from '../api-keys/dto';
import * as audit from '../audit/dto';
import * as auth from '../auth/dto';
import * as deliveries from '../deliveries/dto';
import * as endpointSecrets from '../endpoint-secrets/dto';
import * as endpoints from '../endpoints/dto';
import * as events from '../events/dto';
import * as members from '../members/dto';
import * as organizations from '../organizations/dto';
import * as outbox from '../outbox/dto';
import * as projects from '../projects/dto';
import * as rateLimits from '../rate-limits/dto';
import * as retryPolicies from '../retry-policies/dto';
import * as subscriptions from '../webhook-subscriptions/dto';

/**
 * A NULLABLE PROPERTY MUST SAY WHAT IT IS NULLABLE *OF*.
 *
 * ## What went wrong, so the next author does not re-derive it
 *
 * This project has no `@nestjs/swagger` CLI plugin, so the document is built
 * from `design:type` reflection metadata. TypeScript emits `Object` as the
 * design type of ANY union - so a property declared `string | null` reflects as
 * `Object`, and `@ApiPropertyOptional({ nullable: true })` with no explicit
 * `type` generated:
 *
 *     { "type": "object", "nullable": true }
 *
 * which `openapi-typescript` renders as `Record<string, never> | null`. That is
 * a type to which NO id and NO timestamp is assignable: the generated client
 * literally could not represent the value the API returns. It affected 101
 * properties across 15 DTOs - every nullable field in the API - and the
 * dashboard carried hand-written re-declarations of them for three rounds
 * before this was found.
 *
 * The second half of the same defect: `@ApiPropertyOptional` sets
 * `required: false`. A field declared `name!: string | null` is ALWAYS PRESENT
 * and sometimes null - which is a different contract from a field that may be
 * absent, and a client branching on both is branching on two things where the
 * contract has one. Optional and nullable are not synonyms.
 *
 * ## Why it asserts metadata and source rather than a live document
 *
 * `swagger/apiModelProperties` is the exact input `SwaggerModule` builds the
 * document from, so a rule enforced here cannot be satisfied by the classes and
 * violated by the document. The required-ness half needs the TypeScript
 * declaration (`!:` versus `?:`), which no metadata carries, so that half reads
 * source - the same approach the list-envelope contract already takes.
 */

const SWAGGER_PROPERTIES = 'swagger/apiModelPropertiesArray';
const SWAGGER_PROPERTY = 'swagger/apiModelProperties';

const BARRELS: Array<[string, Record<string, unknown>]> = [
  ['analytics', analytics],
  ['api-keys', apiKeys],
  ['audit', audit],
  ['auth', auth],
  ['deliveries', deliveries],
  ['endpoint-secrets', endpointSecrets],
  ['endpoints', endpoints],
  ['events', events],
  ['members', members],
  ['organizations', organizations],
  ['outbox', outbox],
  ['projects', projects],
  ['rate-limits', rateLimits],
  ['retry-policies', retryPolicies],
  ['webhook-subscriptions', subscriptions],
];

interface DocumentedProperty {
  dto: string;
  property: string;
  options: Record<string, unknown>;
}

/** Every `@ApiProperty`-decorated property on every DTO the API exports. */
function everyDocumentedProperty(): DocumentedProperty[] {
  const found: DocumentedProperty[] = [];

  for (const [, barrel] of BARRELS) {
    for (const exported of Object.values(barrel)) {
      if (typeof exported !== 'function' || !exported.prototype) continue;

      const declared: unknown = Reflect.getMetadata(SWAGGER_PROPERTIES, exported.prototype);
      if (!Array.isArray(declared)) continue;

      for (const entry of declared) {
        const property = String(entry).replace(/^:/, '');
        const options: unknown = Reflect.getMetadata(
          SWAGGER_PROPERTY,
          exported.prototype,
          property,
        );
        if (options && typeof options === 'object') {
          found.push({
            dto: exported.name,
            property,
            options: options as Record<string, unknown>,
          });
        }
      }
    }
  }

  return found;
}

describe('a nullable property declares its type', () => {
  it('finds DTO metadata at all (guards the sweep itself)', () => {
    // If the metadata keys ever change, every assertion below would pass
    // vacuously. This is the canary for that.
    const all = everyDocumentedProperty();
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((entry) => entry.options.nullable === true)).toBe(true);
  });

  /**
   * The `Record<string, never>` bug, in one assertion.
   *
   * `type` or `enum` must be stated explicitly on anything nullable. Reflection
   * cannot supply it - `string | null` reflects as `Object` - so leaving it off
   * silently produces a client field nothing can be assigned to.
   */
  it('never declares nullable without an explicit type or enum', () => {
    const offenders = everyDocumentedProperty()
      .filter((entry) => entry.options.nullable === true)
      .filter((entry) => entry.options.enum === undefined)
      // `type` is NOT simply absent when it was left off: the decorator fills it
      // in from `design:type`, and for any union that is the `Object`
      // CONSTRUCTOR - which serialises to `{"type":"object"}` and generates
      // `Record<string, never>`. Asserting on presence alone passes vacuously,
      // so the bare constructor is what has to be rejected. Note this is a
      // different value from the STRING `'object'`, which is how a genuine map
      // (`custom_headers`, `payload_filter`) is declared, alongside
      // `additionalProperties` - those are correct and stay.
      .filter((entry) => entry.options.type === undefined || entry.options.type === Object)
      .map((entry) => `${entry.dto}.${entry.property}`);

    expect(offenders).toEqual([]);
  });
});

describe('optional and nullable are not the same thing', () => {
  /**
   * A property declared `foo!: T | null` is always present. Documenting it with
   * `@ApiPropertyOptional` (which sets `required: false`) tells a client it may
   * be absent as well as null, which is not true of any response this API
   * sends.
   *
   * Source rather than metadata: only the declaration says whether the property
   * is always present, and `required: false` alone cannot distinguish "may be
   * absent" from "was documented carelessly".
   */
  it('documents an always-present nullable property with @ApiProperty', () => {
    const offenders: string[] = [];
    const root = join(__dirname, '..');

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
        // `@ApiPropertyOptional({ ...nullable: true... })` followed by the
        // property it decorates, with any other decorators in between.
        const pattern =
          /@ApiPropertyOptional\(\{([^;]*?)\}\)\s*(?:@[\w$]+(?:\([^;]*?\))?\s*)*([\w$]+)\s*([!?])\s*:/g;
        for (const match of source.matchAll(pattern)) {
          const [, options, property, marker] = match;
          if (!/\bnullable\s*:\s*true\b/.test(options)) continue;
          if (marker !== '!') continue;
          offenders.push(`${entry}: ${property} is always present but documented optional`);
        }
      }
    };

    walk(root);
    expect(offenders).toEqual([]);
  });
});
