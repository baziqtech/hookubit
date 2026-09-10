import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OpenAPIObject } from '@nestjs/swagger';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { GLOBAL_PREFIX, GLOBAL_PREFIX_EXCLUDE, buildOpenApiDocument } from './openapi-document';

/**
 * THE DOCUMENT IS CUSTOMER-FACING. These are the invariants its two consumers -
 * the generated dashboard client and the public documentation site - depend on,
 * asserted on the document itself rather than on the decorators that feed it.
 *
 * ## Why a real document rather than metadata
 *
 * The nullability contract next door reads `swagger/apiModelProperties`
 * because that rule is about one decorator's options. Every rule here is about
 * how SwaggerModule COMBINES things: a security scheme name declared on a
 * controller against one registered by `DocumentBuilder`; a `{param}` in a path
 * built from `@Controller` against a `parameters` entry that only exists if
 * someone wrote `@ApiParam`. Neither is visible from metadata alone, so the
 * document is built exactly the way `pnpm openapi` builds it - preview mode,
 * no providers, no database - and inspected.
 *
 * ## What each rule caught when it was written
 *
 *  - Every operation referenced a security scheme (`session`) that
 *    `securitySchemes` did not contain (`addCookieAuth('session')` names the
 *    COOKIE, and registered the scheme as `cookie`). A renderer shows that as
 *    an unauthenticated operation.
 *  - Thirty operations under `projects/:projectId/...` declared no `projectId`
 *    parameter at all, and twenty-four declared one with no type - which
 *    `openapi-typescript` renders as `unknown`.
 *  - Descriptions cited `HANDOFF.md`, `ADR-0004`, index names and Go
 *    identifiers. A customer reading `/docs` cannot follow any of those.
 *  - `POST /auth/register` answers 202 by design and was documented as 200.
 */

const BUILD_TIMEOUT_MS = 60_000;

let app: INestApplication;
let document: OpenAPIObject;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: GLOBAL_PREFIX_EXCLUDE });
  document = buildOpenApiDocument(app);
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface Operation {
  method: string;
  path: string;
  operation: Record<string, unknown>;
  pathItem: Record<string, unknown>;
}

function everyOperation(): Operation[] {
  const found: Operation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    const item = pathItem as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation && typeof operation === 'object') {
        found.push({ method, path, operation: operation as Record<string, unknown>, pathItem: item });
      }
    }
  }
  return found;
}

interface Parameter {
  name?: string;
  in?: string;
  schema?: { type?: string };
}

describe('the OpenAPI document', () => {
  it('has routes and security schemes at all (guards the sweep itself)', () => {
    // Preview mode registering nothing would make every rule below pass
    // vacuously; openapi.ts refuses to emit such a document for the same reason.
    expect(everyOperation().length).toBeGreaterThan(40);
    expect(Object.keys(document.components?.securitySchemes ?? {}).length).toBeGreaterThan(0);
  });

  it('references only security schemes that exist in components.securitySchemes', () => {
    const registered = new Set(Object.keys(document.components?.securitySchemes ?? {}));
    const offenders: string[] = [];

    for (const { method, path, operation } of everyOperation()) {
      const requirements = (operation.security ?? []) as Array<Record<string, unknown>>;
      for (const requirement of requirements) {
        for (const scheme of Object.keys(requirement)) {
          if (!registered.has(scheme)) {
            offenders.push(`${method.toUpperCase()} ${path} -> "${scheme}" (have: ${[...registered].join(', ')})`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('declares every {param} in every path, with a type, exactly once', () => {
    const offenders: string[] = [];

    for (const { method, path, operation, pathItem } of everyOperation()) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = [
        ...((pathItem.parameters ?? []) as Parameter[]),
        ...((operation.parameters ?? []) as Parameter[]),
      ].filter((p) => p.in === 'path');

      for (const name of inPath) {
        const matches = declared.filter((p) => p.name === name);
        const label = `${method.toUpperCase()} ${path} {${name}}`;
        if (matches.length === 0) offenders.push(`${label}: not declared`);
        else if (matches.length > 1) offenders.push(`${label}: declared ${matches.length} times`);
        else if (!matches[0].schema?.type) offenders.push(`${label}: declared without a type`);
      }
      for (const p of declared) {
        if (p.name && !inPath.includes(p.name)) {
          offenders.push(`${method.toUpperCase()} ${path}: declares {${p.name}} which is not in the path`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Internal references a customer cannot follow. This is the source-side
   * twin of the grep run on the emitted file; the list is the same.
   */
  it('never cites a file, ADR, index name or code identifier in customer-visible text', () => {
    const internal =
      /HANDOFF|ADR-\d|ARCHITECTURE\.md|\bFIX \d|\w+_idx\b|\.service\.ts|\.go\b|\bsrc\/|\binternal\/|\.ts\b|\.md\b|AppExceptionFilter|ValidationPipe|Match\(\)|signing\.Header|PrismaService|ScopedRepository|schema\.prisma/;
    const offenders: string[] = [];

    const walk = (node: unknown, at: string): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = `${at}.${key}`;
        if (typeof value === 'string') {
          const hit = internal.exec(value);
          if (hit) offenders.push(`${here}: "…${value.slice(Math.max(0, hit.index - 40), hit.index + 40)}…"`);
        } else {
          walk(value, here);
        }
      }
    };

    walk(document.paths, 'paths');
    walk(document.components, 'components');
    walk(document.info, 'info');
    expect(offenders).toEqual([]);
  });

  /**
   * The three enumeration-safe auth routes answer 202 for every input by
   * design (the body is identical whether or not the address exists). The
   * decorators said 200, so a generated client narrowed on a status that never
   * arrives.
   */
  it.each(['/v1/auth/register', '/v1/auth/resend-verification', '/v1/auth/forgot-password'])(
    'documents POST %s as 202 and no other success status',
    (path) => {
      const op = everyOperation().find((o) => o.method === 'post' && o.path === path);
      expect(op).toBeDefined();
      const successCodes = Object.keys(op!.operation.responses as object).filter((c) => c.startsWith('2'));
      expect(successCodes).toEqual(['202']);
    },
  );
});

describe('@ApiParam at the source', () => {
  /**
   * Belt and braces for the typed-parameter rule above: a method-level
   * `@ApiParam` without `type` is silently rescued by `@Param()` reflection, so
   * the document rule cannot see it - until the `@Param()` is refactored away
   * and the parameter becomes `unknown` in the client. Every declaration
   * carries the type so none of them depends on that rescue.
   */
  it('always carries type: String', () => {
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
        for (const match of source.matchAll(/@ApiParam\(\{([^}]*)\}\)/g)) {
          if (!/\btype:\s*String\b/.test(match[1])) {
            const name = /name:\s*'(\w+)'/.exec(match[1])?.[1] ?? '?';
            offenders.push(`${entry}: @ApiParam '${name}' has no type: String`);
          }
        }
      }
    };

    walk(root);
    expect(offenders).toEqual([]);
  });
});
