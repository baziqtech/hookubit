import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { attachErrorResponses } from '../common/openapi-errors';
import { HttpHarness, startOutboxApp } from './testing/harness';

/**
 * THE OPENAPI DOCUMENT IS THE CONTRACT, and it is generated, not hand-written.
 *
 * `apps/dashboard` builds its entire API client from `/docs-json`
 * (`openapi-typescript`), so a decorator that disagrees with the handler does
 * not fail here - it fails months later as a type that does not match the
 * response, and the dashboard grows a hand-written re-declaration to paper over
 * it. That has already happened once in this repo and cost a round of type
 * drift, which is why `openapi-nullability.contract.spec.ts` exists.
 *
 * The specific trap these routes walk into: **Nest defaults a `@Post` to 201**.
 * Both requeue routes are `@HttpCode(200)` because a requeue creates no
 * resource - it moves an existing row back into the queue - so each one needs
 * `@ApiOkResponse` rather than `@ApiCreatedResponse`. Get that pair out of step
 * and the document promises a 201 the server never sends, the generated client
 * types the success branch under a status code that never arrives, and the
 * failure is silent in both directions.
 *
 * Built from the same `SwaggerModule.createDocument` + `attachErrorResponses`
 * pipeline as `main.ts`, so what is asserted here is what a client generates.
 */
describe('the outbox routes in the OpenAPI document', () => {
  let paths: Record<string, Record<string, unknown>>;
  let schemas: Record<string, unknown>;

  let h: HttpHarness;

  beforeAll(async () => {
    // The REAL app from the module's own harness, guards and all, rather than a
    // controller in isolation. `@Authorized` pulls in SessionGuard and
    // TenantGuard, and a hand-stubbed module would drift from what main.ts
    // actually mounts - which is the drift this file exists to catch.
    h = await startOutboxApp();

    const document = attachErrorResponses(
      SwaggerModule.createDocument(h.app, new DocumentBuilder().setVersion('1.0').build()),
    );
    paths = document.paths as Record<string, Record<string, unknown>>;
    schemas = (document.components?.schemas ?? {}) as Record<string, unknown>;
  });

  afterAll(async () => {
    await h.close();
  });

  const operation = (path: string, method: string): Record<string, unknown> => {
    const entry = paths[path];
    expect(entry).toBeDefined();
    const op = entry[method] as Record<string, unknown> | undefined;
    expect(op).toBeDefined();
    return op as Record<string, unknown>;
  };

  const responses = (path: string, method: string): Record<string, unknown> =>
    operation(path, method).responses as Record<string, unknown>;

  const schemaRef = (path: string, method: string, status: string): string => {
    const body = (responses(path, method)[status] as Record<string, unknown>).content as Record<
      string,
      { schema?: { $ref?: string } }
    >;
    return body['application/json'].schema?.$ref ?? '';
  };

  it('publishes exactly the three routes, at the paths the dashboard will call', () => {
    expect(Object.keys(paths).sort()).toEqual([
      '/v1/projects/{projectId}/outbox',
      '/v1/projects/{projectId}/outbox/requeue',
      '/v1/projects/{projectId}/outbox/{outboxId}',
      '/v1/projects/{projectId}/outbox/{outboxId}/requeue',
    ]);
  });

  it('documents each success under the status code the handler actually returns', () => {
    // The @Post/@HttpCode(200) trap. A 201 here would be a lie in the document
    // and a mistyped success branch in the generated client.
    expect(Object.keys(responses('/v1/projects/{projectId}/outbox', 'get'))).toContain('200');
    expect(
      Object.keys(responses('/v1/projects/{projectId}/outbox/{outboxId}/requeue', 'post')),
    ).toContain('200');
    expect(
      Object.keys(responses('/v1/projects/{projectId}/outbox/{outboxId}/requeue', 'post')),
    ).not.toContain('201');
    expect(Object.keys(responses('/v1/projects/{projectId}/outbox/requeue', 'post'))).toContain(
      '200',
    );
    expect(Object.keys(responses('/v1/projects/{projectId}/outbox/requeue', 'post'))).not.toContain(
      '201',
    );
  });

  it('names a response schema on every route, so nothing generates as `unknown`', () => {
    expect(schemaRef('/v1/projects/{projectId}/outbox', 'get', '200')).toBe(
      '#/components/schemas/OutboxEntryListDto',
    );
    expect(schemaRef('/v1/projects/{projectId}/outbox/{outboxId}', 'get', '200')).toBe(
      '#/components/schemas/OutboxEntryDto',
    );
    expect(schemaRef('/v1/projects/{projectId}/outbox/{outboxId}/requeue', 'post', '200')).toBe(
      '#/components/schemas/OutboxEntryDto',
    );
    expect(schemaRef('/v1/projects/{projectId}/outbox/requeue', 'post', '200')).toBe(
      '#/components/schemas/RequeueResultDto',
    );
  });

  it('carries the error envelope on the failures each route can actually produce', () => {
    // attachErrorResponses adds these; asserting them keeps a route from being
    // added later with no documented failure shape at all.
    const requeue = responses('/v1/projects/{projectId}/outbox/{outboxId}/requeue', 'post');
    expect(Object.keys(requeue)).toEqual(expect.arrayContaining(['403', '404', '409']));
    const list = responses('/v1/projects/{projectId}/outbox', 'get');
    expect(Object.keys(list)).toEqual(expect.arrayContaining(['403', '404']));
  });

  it('declares the query filters, so a client cannot invent one', () => {
    const params = operation('/v1/projects/{projectId}/outbox', 'get').parameters as Array<{
      name: string;
      in: string;
      required?: boolean;
    }>;
    const query = params.filter((p) => p.in === 'query').map((p) => p.name).sort();
    expect(query).toEqual(['event_id', 'limit', 'offset', 'status']);
  });

  it('types the path parameters as strings, not `unknown`', () => {
    // `@ApiParam` without `type` emits a parameter with no schema, and
    // openapi-typescript renders that as `unknown` - which is what
    // `ApiKeysController_revoke` currently generates for `projectId`. A path
    // parameter the client cannot type is drift that compiles.
    const on = (path: string, method: string): Array<{ name: string; in: string; schema?: { type?: string } }> =>
      (operation(path, method).parameters ?? []) as Array<{
        name: string;
        in: string;
        schema?: { type?: string };
      }>;

    for (const [path, method] of [
      ['/v1/projects/{projectId}/outbox', 'get'],
      ['/v1/projects/{projectId}/outbox/{outboxId}', 'get'],
      ['/v1/projects/{projectId}/outbox/{outboxId}/requeue', 'post'],
      ['/v1/projects/{projectId}/outbox/requeue', 'post'],
    ] as const) {
      for (const param of on(path, method).filter((p) => p.in === 'path')) {
        expect([`${method} ${path} ${param.name}`, param.schema?.type]).toEqual([
          `${method} ${path} ${param.name}`,
          'string',
        ]);
      }
    }

    // And every route that has an id in its URL declares it.
    expect(on('/v1/projects/{projectId}/outbox/{outboxId}', 'get').map((p) => p.name).sort()).toEqual(
      ['outboxId', 'projectId'],
    );
  });

  it('types every field of the outbox entry - no bare `object` on a nullable', () => {
    // The `Record<string, never>` bug: TypeScript reflects `string | null` as
    // the `Object` CONSTRUCTOR, which serialises to `{"type":"object"}` and
    // generates a type nothing is assignable to. The global sweep in
    // openapi-nullability.contract.spec.ts covers every DTO; this pins the
    // rendered document for the one resource whose row is almost all nullables.
    const entry = schemas.OutboxEntryDto as {
      properties: Record<string, { type?: string; nullable?: boolean }>;
      required?: string[];
    };
    for (const [name, property] of Object.entries(entry.properties)) {
      if (!property.nullable) continue;
      expect([name, property.type]).toEqual([name, expect.stringMatching(/^(string|number)$/)]);
    }
    // Always present, sometimes null - a different contract from "may be absent".
    expect(entry.required).toEqual(expect.arrayContaining(['last_error', 'routing_cursor']));
  });

  it('documents the two counters, because their difference is the whole diagnosis', () => {
    const entry = schemas.OutboxEntryDto as {
      properties: Record<string, { description?: string }>;
    };
    expect(entry.properties.attempts.description).toContain('Monotonic');
    expect(entry.properties.unaccounted_attempts.description).toContain(
      'writing nothing at all',
    );
    expect(entry.properties.routing_cursor.description).toContain('PARTLY done');
  });
});
