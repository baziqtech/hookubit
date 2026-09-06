import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { Response } from 'express';
import { AppError } from '../common/errors';
import { AuthenticatedRequest, SessionGuard } from './session.guard';
import { SESSION_COOKIE, SessionService } from './session.service';
import { FakePrisma } from './testing/prisma.fake';

const USER_ID = 'usr_1';
const EMAIL = 'ada@example.com';

function seedUser(prisma: FakePrisma): User {
  const user: User = {
    id: USER_ID,
    email: EMAIL,
    name: null,
    passwordHash: 'x',
    emailVerifiedAt: null,
    lastLoginAt: null,
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  prisma.users.set(user.id, user);
  return user;
}

/** Minimal ExecutionContext carrying just the cookie the guard reads. */
function contextWith(cookie?: string): ExecutionContext {
  const req = { cookies: cookie ? { [SESSION_COOKIE]: cookie } : {} } as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function build(): Promise<{ guard: SessionGuard; prisma: FakePrisma; cookie: string }> {
  const prisma = new FakePrisma();
  seedUser(prisma);
  const jwt = new JwtService({ secret: 'x'.repeat(48) });
  const config = { get: () => 'test' } as unknown as ConfigService;
  const sessions = new SessionService(jwt, prisma.asPrisma(), config);

  const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response & {
    cookie: jest.Mock;
  };
  await sessions.issue(res, { userId: USER_ID, email: EMAIL });
  const cookie = res.cookie.mock.calls[0][1] as string;

  return { guard: new SessionGuard(sessions), prisma, cookie };
}

describe('SessionGuard', () => {
  it('admits a live session and attaches the user to the request', async () => {
    const h = await build();
    const ctx = contextWith(h.cookie);

    await expect(h.guard.canActivate(ctx)).resolves.toBe(true);

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    expect(req.sessionUser).toMatchObject({ userId: USER_ID, email: EMAIL });
  });

  it('rejects a request with no cookie', async () => {
    const h = await build();
    await expect(h.guard.canActivate(contextWith())).rejects.toBeInstanceOf(AppError);
    await expect(h.guard.canActivate(contextWith())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rejects a forged cookie', async () => {
    const h = await build();
    await expect(h.guard.canActivate(contextWith('not-a-jwt'))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  /**
   * The guard is exported from AuthModule for other modules to mount, and Phase
   * 2 puts organizations, projects, api-keys and endpoints behind it. Verifying
   * only the signature and the session row meant an admin could set
   * `users.disabled_at` and the JWT would keep working for the rest of its
   * seven-day life on any route that trusted the guard alone.
   */
  it('REGRESSION (FIX 4): refuses a disabled account holding a valid cookie', async () => {
    const h = await build();
    await expect(h.guard.canActivate(contextWith(h.cookie))).resolves.toBe(true);

    const user = h.prisma.users.get(USER_ID)!;
    h.prisma.users.set(USER_ID, { ...user, disabledAt: new Date() });

    await expect(h.guard.canActivate(contextWith(h.cookie))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('REGRESSION (FIX 4): refuses a cookie whose account was deleted', async () => {
    const h = await build();
    h.prisma.users.delete(USER_ID);

    await expect(h.guard.canActivate(contextWith(h.cookie))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
