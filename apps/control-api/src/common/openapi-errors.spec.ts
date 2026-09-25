import { OpenAPIObject } from '@nestjs/swagger';
import { ERROR_CODES } from './errors';
import { API_ERROR_SCHEMA_NAME, attachErrorResponses } from './openapi-errors';

/**
 * The error envelope is part of the contract, so it is tested like one.
 *
 * The document used to describe 150 4xx responses and give a schema for none of
 * them. Every client then hand-typed error handling - the same drift that had
 * just been removed from the success types, reintroduced one catch block at a
 * time.
 */

function documentWith(responses: Record<string, unknown>): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: { '/v1/things': { get: { responses } } },
  } as unknown as OpenAPIObject;
}

/**
 * Walk a document by path. The document is a plain JSON tree, so reading it
 * with typed accessors rather than casts keeps the assertions honest about
 * what they found - a wrong path yields `undefined` and fails loudly, instead
 * of an `any` that silently reads as whatever the assertion wants.
 */
function at(root: unknown, ...path: Array<string | number>): unknown {
  let node: unknown = root;
  for (const step of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[String(step)];
  }
  return node;
}

function errorSchema(document: OpenAPIObject): unknown {
  return at(document, 'components', 'schemas', API_ERROR_SCHEMA_NAME);
}

/** The single operation every fixture in this file declares. */
function responses(document: OpenAPIObject): unknown {
  return at(document, 'paths', '/v1/things', 'get', 'responses');
}

describe('attachErrorResponses', () => {
  it('registers the envelope as a reusable component', () => {
    const document = attachErrorResponses(documentWith({ 404: { description: 'Not found' } }));
    expect(at(errorSchema(document), 'type')).toBe('object');
    expect(at(errorSchema(document), 'required')).toEqual(['error']);
  });

  it('points every 4xx and 5xx response at it', () => {
    const document = attachErrorResponses(
      documentWith({
        400: { description: 'Bad request' },
        403: { description: 'Forbidden' },
        429: { description: 'Slow down' },
        500: { description: 'Boom' },
      }),
    );
    for (const status of ['400', '403', '429', '500']) {
      expect(
        at(responses(document), status, 'content', 'application/json', 'schema'),
      ).toEqual({ $ref: `#/components/schemas/${API_ERROR_SCHEMA_NAME}` });
    }
  });

  it('leaves success responses alone', () => {
    const document = attachErrorResponses(documentWith({ 200: { description: 'OK' } }));
    expect(at(responses(document), '200', 'content')).toBeUndefined();
  });

  it('never overwrites a response that already declares content', () => {
    const existing = { 'application/json': { schema: { $ref: '#/components/schemas/Custom' } } };
    const document = attachErrorResponses(
      documentWith({ 409: { description: 'Conflict', content: existing } }),
    );
    expect(at(responses(document), '409', 'content')).toBe(existing);
  });

  it('names the codes that share a status, so a 409 can be told apart', () => {
    const document = attachErrorResponses(documentWith({ 409: { description: 'Conflict' } }));
    const description = at(responses(document), '409', 'description') as string;
    // All three 409s are distinct failures a client must handle differently.
    expect(description).toContain('conflict');
    expect(description).toContain('limit_exceeded');
    expect(description).toContain('idempotency_key_reused');
  });
});

describe('the envelope matches what AppExceptionFilter actually sends', () => {
  const document = attachErrorResponses(documentWith({ 400: { description: 'x' } }));
  const error = at(errorSchema(document), 'properties', 'error');

  it('enumerates exactly the codes the filter can emit', () => {
    // Derived from ERROR_CODES rather than restated, so adding a code cannot
    // leave the document behind.
    const codes = at(error, 'properties', 'code', 'enum') as string[];
    expect([...codes].sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });

  it('requires code, message and request_id on every error', () => {
    expect(at(error, 'required')).toEqual(['code', 'message', 'request_id']);
  });

  /**
   * The one the dashboard had to discover from a network tab: `ValidationPipe`
   * puts one entry per rejected field into `message` as a STRING ARRAY, and it
   * is the only field map this API returns. A schema saying `type: string`
   * would be a lie that survives generation.
   */
  it('allows message to be a string OR a string array', () => {
    expect(at(error, 'properties', 'message', 'oneOf')).toEqual([
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ]);
  });

  /** `limit_exceeded` ALWAYS carries these three; they are the contract. */
  it('documents the limit_exceeded details shape', () => {
    const properties = at(error, 'properties', 'details', 'properties');
    expect(Object.keys(properties as object)).toEqual(
      expect.arrayContaining(['limit', 'current', 'resource']),
    );
    expect(at(properties, 'limit', 'type')).toBe('number');
    expect(at(properties, 'current', 'type')).toBe('number');
    expect(at(properties, 'resource', 'type')).toBe('string');
  });

  it('keeps details open, because other codes add their own keys', () => {
    // `rate_limited` carries retry_after_seconds; the set is not closed.
    expect(at(error, 'properties', 'details', 'additionalProperties')).toBe(true);
  });

  it('does not mark details required', () => {
    expect(at(error, 'required')).not.toContain('details');
  });
});
