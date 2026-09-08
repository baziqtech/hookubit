import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Response headers a browser client is allowed to READ.
 *
 * A cross-origin browser can only see six CORS-safelisted response headers;
 * every other one is present on the wire and silently dropped before it reaches
 * JavaScript. Nothing errors, so a header the server sets correctly simply does
 * not exist for the client, which is how this went unnoticed.
 *
 *  - `Retry-After` is set by ThrottleGuard on every 429. Without it here the
 *    dashboard could only read `details.retry_after_seconds` out of the error
 *    body, so a 429 raised by anything that is NOT this guard - an ingress rate
 *    limit, a WAF, a load balancer - arrived with no usable "try again in N"
 *    at all, and the panel had to guess or say nothing.
 *  - `x-request-id` is minted (or accepted, if well-formed) per request in
 *    app.module.ts and repeated in every error body as `request_id`. It is the
 *    string an operator asks for in a support ticket, and a client that cannot
 *    read the header cannot attach it to a report on a SUCCESSFUL response,
 *    where there is no error body to carry it.
 *
 * Nothing else is missing. The only other header this API sets is `Set-Cookie`,
 * which browsers refuse to expose to script whatever this list says - by
 * design, and the session cookie is HttpOnly regardless.
 *
 * Header names here are matched case-insensitively by the browser; they are
 * spelled the way the code that sets them spells them.
 */
export const EXPOSED_HEADERS = ['Retry-After', 'x-request-id'] as const;

/**
 * `origin: false` for an unset CORS_ORIGINS means "no cross-origin request is
 * allowed", NOT "allow everything" - a credentialed API must never reflect an
 * arbitrary origin, and an empty configuration has to fail closed.
 */
export function corsOptions(rawOrigins: string | undefined): CorsOptions {
  const origins = (rawOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin: origins.length ? origins : false,
    credentials: true,
    exposedHeaders: [...EXPOSED_HEADERS],
  };
}
