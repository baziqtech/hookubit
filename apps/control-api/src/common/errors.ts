import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { requestIdForResponse } from './request-id';

/**
 * Stable, machine-readable error codes (ARCHITECTURE.md 48).
 * Never remove or repurpose a code; add new ones.
 */
export const ERROR_CODES = {
  invalid_request: HttpStatus.BAD_REQUEST,
  unauthenticated: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  /**
   * Credentials were correct but the address has never been proved (FIX 5).
   * Distinct from `unauthenticated` so a client can offer "resend the link";
   * safe to distinguish because it is only ever reached after a successful
   * password check, so it tells the caller nothing they did not already know.
   */
  email_not_verified: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  /**
   * A per-tenant RESOURCE CEILING was reached (projects per organization, keys
   * or endpoints or subscriptions per project, ...). Still 409, because the
   * request was well-formed and the caller may retry after freeing a slot -
   * but a distinct CODE, because `conflict` already means "a duplicate slug",
   * "this endpoint is deleted" and "another writer got there first", and a
   * client that must tell those apart was reduced to matching on the
   * human-readable message. That breaks silently the first time someone
   * rewords a sentence.
   *
   * Every `limit_exceeded` MUST carry structured details:
   * `{ limit, current, resource }` - the ceiling, what the tenant holds now,
   * and which resource it is. The message is for a human; the details are the
   * contract.
   */
  limit_exceeded: HttpStatus.CONFLICT,
  idempotency_key_reused: HttpStatus.CONFLICT,
  payload_too_large: HttpStatus.PAYLOAD_TOO_LARGE,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  internal_error: HttpStatus.INTERNAL_SERVER_ERROR,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, ERROR_CODES[code]);
  }
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);


  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    // `req.id` is the id pino minted or accepted (FIX 7); fall back to the raw
    // header only when it passes the same check, so an unvalidated client string
    // cannot reach an error body either.
    const requestId = requestIdForResponse(req);

    if (exception instanceof AppError) {
      res.status(exception.getStatus()).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          request_id: requestId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json({
        error: {
          code: status === HttpStatus.BAD_REQUEST ? 'invalid_request' : 'internal_error',
          message:
            typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? exception.message),
          request_id: requestId,
        },
      });
      return;
    }

    // Never silently swallow (engineering rule 13).
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred', request_id: requestId },
    });
  }
}
