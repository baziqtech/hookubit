import { Prisma } from '@prisma/client';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import {
  ATTR_DB_COLLECTION_NAME,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_SYSTEM_NAME,
  ATTR_ERROR_TYPE,
} from '@opentelemetry/semantic-conventions';
import { isTracingEnabled, tracer } from './tracing.runtime';

/**
 * A span per database operation, with NO new dependency.
 *
 * ## Why `$use` and not Prisma's own OpenTelemetry integration
 *
 * `@prisma/instrumentation` is the supported route and it is not installed here.
 * Adding it would pull in `@opentelemetry/instrumentation`, which monkey-patches
 * module loading to hook the client - a large amount of machinery, and a boot-
 * order constraint (it must be registered before `@prisma/client` is required)
 * that `main.ts` would have to be rearranged around. What it buys over this is
 * finer spans: engine-level `serialize`/`connection`/`db_query` phases below the
 * operation. What this is for is "which query is behind the slow request", and
 * an operation-level span answers that.
 *
 * `$use` is soft-deprecated in favour of client extensions. It is used anyway
 * because an extension returns a NEW client object rather than mutating the one
 * Nest injects, so adopting one would mean changing what `PrismaService` IS -
 * a real change to the type every repository is written against, for a
 * cross-cutting concern that must be removable without touching them. If the
 * hook is ever dropped by Prisma, the replacement is a client extension applied
 * inside `PrismaService`, and nothing outside that file changes.
 *
 * ## What is deliberately NOT recorded
 *
 * `params.args`. It is the query's actual VALUES: the argon2 hash on a login,
 * the session token on every authenticated request, the ciphertext and key id
 * of an endpoint secret, the email address of the user being invited. There is
 * no redaction of it worth writing, because the interesting fields are nested
 * inside `where`/`data`/`select` trees that differ per call - so it is not
 * recorded at all, and neither is a rendered statement. The model name and the
 * operation name are a closed set drawn from the schema, and they are enough
 * to find the query in the code.
 */
export function prismaTracingMiddleware(): Prisma.Middleware {
  return async (params, next) => {
    if (!isTracingEnabled()) return next(params);

    const span = tracer().startSpan(spanName(params), {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_DB_SYSTEM_NAME]: 'postgresql',
        [ATTR_DB_OPERATION_NAME]: params.action,
        ...(params.model ? { [ATTR_DB_COLLECTION_NAME]: params.model } : {}),
      },
    });

    try {
      return await context.with(trace.setSpan(context.active(), span), () => next(params));
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, errorType(err));
      throw err;
    } finally {
      span.end();
    }
  };
}

/**
 * `{operation} {target}`, per the database semantic conventions - `findMany
 * Endpoint`. Both halves come from the generated schema, so the name is drawn
 * from a closed set and never from a row.
 */
function spanName(params: Prisma.MiddlewareParams): string {
  return params.model ? `${params.action} ${params.model}` : params.action;
}

/**
 * The error's SHAPE, never its message.
 *
 * A `PrismaClientKnownRequestError` message quotes the failing constraint and,
 * for some codes, the conflicting value; `PrismaClientInitializationError`
 * quotes the connection string. The code (`P2002`, `P2025`) is what an operator
 * actually reads and carries none of that.
 */
function errorType(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    const name = (err as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'unknown';
}
