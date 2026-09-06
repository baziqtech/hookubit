import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { AppError } from './errors';
import { THROTTLE_STORE, ThrottleStore } from './throttle.store';

export const THROTTLE_KEY = 'throttle:options';

export interface ThrottleOptions {
  /** Bucket name; keeps login and forgot-password counting separately. */
  name: string;
  limit: number;
  windowMs: number;
  /**
   * Also count per value of this request-body field, so one attacker spraying a
   * single account from many addresses is limited too. The value is hashed
   * before it becomes a map key - an email address is PII and must not sit in
   * process memory (or a Redis keyspace) in the clear.
   */
  byBodyField?: string;
  /**
   * Whether the per-address bucket may REFUSE a request, as opposed to merely
   * being counted. Default true.
   *
   * False for the token-consuming routes (reset-password, verify-email). Those
   * carry a 256-bit single-use token: guessing one is not a threat that rate
   * limiting addresses, and they have no `byBodyField`, so their bucket is
   * per-address only. Behind a proxy that bucket aggregates real users, and a
   * few dozen anonymous requests would 429 everyone trying to finish a reset -
   * the limit would deny service rather than prevent an attack. The count is
   * still kept, so the pressure is visible to an operator and a future
   * per-subject bucket can enforce on top of it.
   */
  enforcePerIp?: boolean;
}

export const Throttle = (options: ThrottleOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_KEY, options);

/**
 * Rate limiting for unauthenticated auth endpoints (FIX 8).
 *
 * Login, registration, forgot-password and reset-password had no limit, which
 * made them an open brute-force and account-enumeration surface: an attacker
 * could try passwords as fast as argon2 would answer, and mail a user an
 * unbounded number of reset links.
 *
 * Only handlers carrying @Throttle are limited; the guard is a no-op elsewhere,
 * so mounting it on a controller cannot accidentally throttle a read.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(THROTTLE_STORE) private readonly store: ThrottleStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<ThrottleOptions | undefined>(THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const enforcePerIp = options.enforcePerIp !== false;
    const buckets = [{ key: `${options.name}:ip:${ThrottleGuard.clientIp(req)}`, enforced: enforcePerIp }];
    const subject = ThrottleGuard.bodyValue(req, options.byBodyField);
    if (subject) {
      buckets.push({ key: `${options.name}:sub:${ThrottleGuard.fingerprint(subject)}`, enforced: true });
    }

    // Every bucket is charged even once one is over, so an attacker cannot use
    // a tripped IP limit to avoid tripping the per-account limit.
    const hits = await Promise.all(
      buckets.map(async (bucket) => ({
        ...(await this.store.hit(bucket.key, options.windowMs)),
        enforced: bucket.enforced,
      })),
    );
    const exceeded = hits.filter((hit) => hit.enforced && hit.count > options.limit);
    if (exceeded.length === 0) return true;

    const resetAt = Math.max(...exceeded.map((hit) => hit.resetAt));
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    throw new AppError('rate_limited', 'Too many attempts. Try again shortly.', {
      retry_after_seconds: retryAfter,
    });
  }

  /**
   * The address this request is charged to.
   *
   * `req.ip` is only as good as `trust proxy`, and that setting lives in
   * main.ts, NOT here: Express returns the socket address unless an exact hop
   * count has been configured (see config/trust-proxy.ts). Until that was set,
   * every request behind the ingress reported the ingress controller's pod IP,
   * collapsing the whole platform into a single bucket - the fault this comment
   * previously claimed could not happen.
   *
   * The socket fallback is for a missing `req.ip` only (a non-Express adapter,
   * a synthetic request in a test); it is not a substitute for the setting.
   */
  private static clientIp(req: Request): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  private static bodyValue(req: Request, field?: string): string | null {
    if (!field) return null;
    const body = req.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
  }

  private static fingerprint(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 22);
  }
}
