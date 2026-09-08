import { OpenAPIObject } from '@nestjs/swagger';
import { ERROR_CODES, ErrorCode } from './errors';

/**
 * The error envelope, in the OpenAPI document.
 *
 * ## Why this exists
 *
 * The document described 150 4xx responses and gave a schema for NONE of them,
 * so every generated client typed error handling by hand - the exact drift that
 * had just been removed from the success types. A client that cannot name the
 * failure shape re-derives it from observed responses, which is how
 * `error.message` being a string ARRAY on a validation failure was discovered
 * by a human reading a network tab.
 *
 * ## Why raw schema objects rather than a DTO class
 *
 * Two of these fields cannot be stated truthfully with `@ApiProperty`:
 *
 *  - `message` is a string on most errors and a string ARRAY on a validation
 *    failure (`ValidationPipe` puts the whole field map there, and it is the
 *    ONLY field map available - there is no `errors` object). That is a
 *    `oneOf`, which the decorator layer cannot express without an escape hatch.
 *  - `code` must enumerate `ERROR_CODES` exactly, and deriving it from that
 *    object is what stops the document and `AppExceptionFilter` drifting apart.
 *
 * Writing the schema literally means the document says precisely this and
 * nothing is inferred from TypeScript metadata - which is the failure mode the
 * nullability pass in this same change had to undo across 101 properties.
 */

/** Every code the filter can emit, straight from the map it emits them from. */
export const ERROR_CODE_VALUES = Object.keys(ERROR_CODES) as ErrorCode[];

/** `ApiErrorResponse`, the component every error response points at. */
export const API_ERROR_SCHEMA_NAME = 'ApiErrorResponse';

const errorSchema: Record<string, unknown> = {
  type: 'object',
  required: ['error'],
  description:
    'The response body of EVERY non-2xx response from this API. There is no other error ' +
    'shape: `AppExceptionFilter` is a catch-all filter, so even an unhandled exception is ' +
    'rendered as this envelope with `code: "internal_error"`.',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'request_id'],
      properties: {
        code: {
          type: 'string',
          enum: ERROR_CODE_VALUES,
          description:
            'STABLE and machine-readable - branch on this, never on `message`. Codes are ' +
            'never removed or repurposed, only added. Several share an HTTP status on ' +
            'purpose: `conflict`, `limit_exceeded` and `idempotency_key_reused` are all 409, ' +
            'and a client that must tell them apart was previously reduced to matching on ' +
            'the human-readable sentence.',
        },
        message: {
          description:
            'For a HUMAN. A STRING on most errors, but a STRING ARRAY on a validation ' +
            'failure - `ValidationPipe` puts one entry per rejected field here, and it is ' +
            'the only field map this API returns. Narrow before rendering it.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        request_id: {
          type: 'string',
          description:
            'The correlation id, echoed from a well-formed `x-request-id` or minted here. ' +
            'It appears on the matching log lines; quote it in a bug report.',
          example: 'req_2f8b0c1e-6a4d-4c2e-9f10-3b5a7c9d1e22',
        },
        details: {
          type: 'object',
          additionalProperties: true,
          description:
            'Structured, code-specific context. ABSENT on most errors. Two shapes are part ' +
            'of the contract: `limit_exceeded` ALWAYS carries `{ limit, current, resource }` ' +
            '- the ceiling, what the tenant holds now, and which resource - and `rate_limited` ' +
            'carries `retry_after_seconds`. The message is for a human; these are the ' +
            'contract. Other codes may add keys, so this is not closed.',
          properties: {
            limit: {
              type: 'number',
              description: 'The ceiling that was reached. Always present on `limit_exceeded`.',
            },
            current: {
              type: 'number',
              description: 'What the tenant holds now. Always present on `limit_exceeded`.',
            },
            resource: {
              type: 'string',
              description:
                'Which resource the ceiling covers. Always present on `limit_exceeded`.',
            },
            retry_after_seconds: {
              type: 'number',
              description:
                'How long to wait before retrying. Present on `rate_limited`; mirrors the ' +
                '`Retry-After` header.',
            },
          },
        },
      },
    },
  },
};

/** The codes that can appear under each HTTP status, derived from `ERROR_CODES`. */
function codesForStatus(status: number): ErrorCode[] {
  return ERROR_CODE_VALUES.filter((code) => ERROR_CODES[code] === status);
}

/**
 * Attach the envelope to every documented error response, and register the
 * schema it points at.
 *
 * A DOCUMENT PASS rather than 150 `@ApiResponse({ type: ... })` decorators, for
 * two reasons. Most of those 150 responses are not written by hand at all -
 * they come from shared authorization decorators - so there is no single
 * decorator site to edit. And a pass cannot be forgotten: a route added
 * tomorrow gets the envelope without its author knowing this file exists, which
 * is the only version of this that stays true.
 *
 * Responses that already declare content are left alone.
 */
export function attachErrorResponses(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas[API_ERROR_SCHEMA_NAME] = errorSchema as never;

  for (const path of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(path ?? {})) {
      const responses = (operation as { responses?: Record<string, Record<string, unknown>> })
        ?.responses;
      if (!responses) continue;

      for (const [status, response] of Object.entries(responses)) {
        const code = Number(status);
        if (!Number.isInteger(code) || code < 400) continue;
        if (response.content) continue;

        const possible = codesForStatus(code);
        response.content = {
          'application/json': {
            schema: { $ref: `#/components/schemas/${API_ERROR_SCHEMA_NAME}` },
          },
        };
        if (possible.length > 0) {
          const listed = possible.map((value) => `\`${value}\``).join(', ');
          response.description = response.description
            ? `${String(response.description)} (error.code: ${listed})`
            : `error.code is one of: ${listed}`;
        }
      }
    }
  }

  return document;
}
