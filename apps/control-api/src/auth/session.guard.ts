import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { AppError } from '../common/errors';
import { SESSION_COOKIE, SessionService, SessionUser } from './session.service';

export interface AuthenticatedRequest extends Request {
  cookies: Record<string, string | undefined>;
  sessionUser?: SessionUser;
}

export function readSessionCookie(req: Request): string | null {
  const cookies = (req as AuthenticatedRequest).cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

/**
 * Authenticates a browser session from the HTTP-only cookie.
 *
 * It proves four things, all via `SessionService.verify`: the cookie was signed
 * by this deployment, it has not expired, its `sessions` row is still live, and
 * the account behind it still exists and is not disabled. That last check was
 * missing (FIX 4) - the guard is exported for other modules to mount, and one
 * that trusted it alone would have let a disabled user keep working for the
 * remaining life of their JWT, up to seven days.
 *
 * Authorization (roles, org scoping) is a separate concern - see
 * ARCHITECTURE.md 10 - and must not be folded in here. "Is this account still
 * allowed to authenticate at all" is authentication, not authorization.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(req);
    if (!token) throw new AppError('unauthenticated', 'Authentication required.');

    const user = await this.sessions.verify(token);
    if (!user) throw new AppError('unauthenticated', 'Session is invalid or has expired.');

    req.sessionUser = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator<unknown, ExecutionContext, SessionUser>(
  (_data, context) => {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.sessionUser) {
      // Reachable only if the handler forgot SessionGuard; fail closed.
      throw new AppError('unauthenticated', 'Authentication required.');
    }
    return req.sessionUser;
  },
);
