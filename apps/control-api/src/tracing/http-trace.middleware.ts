import { Injectable, NestMiddleware } from '@nestjs/common';
import {
  Attributes,
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import { NextFunction, Request, Response } from 'express';
import type { TenantRequest } from '../authz/tenant-context';
import { requestIdForResponse } from '../common/request-id';
import { ATTR_WEBHOOK_REQUEST_ID, setSafeAttribute, tenantAttributes } from './span-attributes';
import { isTracingEnabled, tracer } from './tracing.runtime';

/**
 * Kubernetes probes both endpoints on a short interval, for ever, on every
 * replica. They are the highest-volume "request" this service serves and the
 * least interesting: a liveness probe that is slow is a Prometheus alert, not a
 * trace. Excluded here rather than by `MiddlewareConsumer.exclude` because the
 * exclusion list there is interpreted relative to the global prefix, which these
 * two routes are explicitly excluded from - a mismatch that fails silently by
 * tracing them anyway.
 */
const UNTRACED_PATHS: ReadonlySet<string> = new Set(['/health/live', '/health/ready']);

/**
 * The request path as the CLIENT sent it.
 *
 * Not `req.path`: Nest binds this middleware with `app.use(mountPath, ...)`,
 * and Express strips the mount path off `req.url` inside a mounted handler, so
 * `req.path` is `/` for exactly the probe requests the exclusion above is meant
 * to catch. `originalUrl` survives the mount; the query string is dropped
 * because it is not part of the identity of the route and, on this API, is the
 * part most likely to carry a token.
 */
function requestPath(req: Request): string {
  const url = req.originalUrl || req.url;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** Express fills `route` in once a layer matches; it is `any` in @types/express. */
type RoutedRequest = Omit<Request, 'route'> & { route?: { path?: unknown } };

/**
 * The HTTP server span.
 *
 * ## Why middleware and not an interceptor
 *
 * An interceptor runs AFTER the guards. On this control plane the guards are
 * where a slow request usually is: `SessionGuard` verifies the session against
 * the database and `TenantGuard` resolves the tenant, sometimes walking
 * delivery -> endpoint -> project -> organization. A span that started after
 * all that would answer "which request was slow?" with the one part of the
 * request that was fast. Middleware runs first, so the span covers guards,
 * pipes, the handler and serialisation.
 *
 * ## Why the span is named at the END of the request
 *
 * The name has to be the route TEMPLATE - `/v1/projects/:projectId/endpoints` -
 * and Express does not know which route matched until it has matched one, which
 * is after this middleware has already had to start the span. So it starts as
 * `HTTP GET` and is renamed on `finish`, which is also the first moment the
 * status code and the resolved tenant exist.
 *
 * Interpolating the id into the name instead would make the span name unbounded:
 * one distinct "operation" per project in the system, which is not a naming
 * problem but a bill - every trace backend aggregates, indexes and prices by
 * span name. A request that matched no route keeps the bare `HTTP GET` for the
 * same reason; the 404 is on the status code where it belongs.
 */
@Injectable()
export class HttpTraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (!isTracingEnabled() || UNTRACED_PATHS.has(requestPath(req))) {
      next();
      return;
    }

    // Continue an upstream trace when the caller sent `traceparent`. The
    // sampler - not this - decides whether that upstream decision gets to
    // increase our span volume; see the ParentBasedSampler in
    // tracer-provider.service.ts.
    const parent = propagation.extract(context.active(), req.headers);

    const span = tracer().startSpan(
      `HTTP ${req.method}`,
      { kind: SpanKind.SERVER, attributes: startAttributes(req) },
      parent,
    );

    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      try {
        completeSpan(span, req, res);
      } catch {
        // A span that cannot be described is still a span that must be closed,
        // and nothing in here may reach the response.
      }
      span.end();
    };

    // `finish` for a response that was written, `close` for a client that hung
    // up first. Without the second, an aborted request leaks a span that is
    // never exported and never freed.
    res.once('finish', finish);
    res.once('close', finish);

    try {
      context.with(trace.setSpan(parent, span), next);
    } catch (err) {
      finish();
      throw err;
    }
  }
}

function startAttributes(req: Request): Attributes {
  const attributes: Attributes = { [ATTR_HTTP_REQUEST_METHOD]: req.method };

  // `req.ip` is only correct because main.ts sets an EXACT trust-proxy hop
  // count before anything reads it. Behind a proxy with the default of 0 this
  // is the proxy's address, which is the same value the rate limiter and the
  // request log already use - consistent, and wrong in the same, documented way.
  const ip = req.ip;
  if (ip) attributes[ATTR_CLIENT_ADDRESS] = ip;

  // The one attribute taken from a client header. Truncated, and `user-agent`
  // is the only header read at all: no `authorization`, no `cookie`, no bag.
  const agent = req.headers['user-agent'];
  if (typeof agent === 'string') {
    const value = agent.trim();
    if (value !== '') attributes[ATTR_USER_AGENT_ORIGINAL] = value;
  }

  return attributes;
}

function completeSpan(span: Span, req: Request, res: Response): void {
  const route = routeTemplate(req);
  if (route) {
    span.updateName(`${req.method} ${route}`);
    span.setAttribute(ATTR_HTTP_ROUTE, route);
  }

  const status = res.statusCode;
  span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);

  // Correlates a log line to a trace in the direction the log does not: pino
  // puts `trace_id` on every line, this puts the request id on the span.
  setSafeAttribute(span, ATTR_WEBHOOK_REQUEST_ID, requestIdForResponse(req));

  // Only ever from the resolved tenant context, never from route parameters -
  // the whole argument is in span-attributes.ts.
  span.setAttributes(tenantAttributes(req as TenantRequest));

  // Semantic conventions: a SERVER span is an error only on 5xx. A 401, a 403
  // and the deliberately opaque 404 are the API working correctly, and marking
  // them Error would put a permanent red bar under a healthy login page.
  if (status >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(ATTR_ERROR_TYPE, String(status));
  }
}

/**
 * The registered route template, or undefined.
 *
 * `req.baseUrl` is deliberately NOT prepended. It is the matched mount prefix -
 * already interpolated - not a template, so prepending it is exactly the
 * unbounded-cardinality mistake this function exists to avoid. It is also
 * always empty here: `app.setGlobalPrefix('v1')` makes Nest register the prefix
 * as part of each route's own path, so `route.path` is already the full
 * `/v1/...` template.
 */
export function routeTemplate(req: Request): string | undefined {
  const path = (req as unknown as RoutedRequest).route?.path;
  if (typeof path === 'string') return path === '' ? undefined : path;
  // Express allows an array of paths on one route. A RegExp route has no
  // template worth reporting, and neither does anything else.
  if (Array.isArray(path) && path.every((p) => typeof p === 'string')) {
    return path.length > 0 ? path.join(',') : undefined;
  }
  return undefined;
}
