import { AddressInfo } from 'node:net';
import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AuditService, TenantGuard, TenantResolver, TenantScopeFactory } from '../../authz';
import { SessionGuard } from '../../auth/session.guard';
import { SESSION_COOKIE, SessionService, SessionUser } from '../../auth/session.service';
import { AppExceptionFilter } from '../../common/errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OrganizationsService } from '../organizations.service';
import { TenantTransactionRunner } from '../tenant-transaction';
import { UserDirectory } from '../user-directory';
import { UserScopeFactory, UserScopeGuard } from '../user-scope';
import { FakeWorld } from './world';

/**
 * These modules as a browser meets them: real Nest, real guards mounted by the
 * decorators, real routing, the real global `ValidationPipe` from `main.ts` and
 * the real exception filter.
 *
 * The service suites prove the rules. This one proves the WIRING - that
 * `@UserScoped()` and `@Authorized()` are actually mounted, that the
 * not-found/forbidden policy survives to a status code, and that
 * `forbidNonWhitelisted` really rejects the fields the DTOs deliberately do not
 * declare (`user_id` on an invite being the one that matters).
 *
 * `SessionService` is stubbed - the cookie is just a user id - because
 * authentication has its own suite. Everything else is the production class.
 */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
}

export interface TestHarness {
  app: INestApplication;
  call(
    method: string,
    path: string,
    options?: { as?: string; body?: unknown },
  ): Promise<HttpResult>;
}

export async function createHarness(
  db: FakeWorld,
  controllers: Type<unknown>[],
  extraProviders: Parameters<typeof Test.createTestingModule>[0]['providers'] = [],
): Promise<TestHarness> {
  const moduleRef = await Test.createTestingModule({
    controllers,
    providers: [
      { provide: PrismaService, useValue: db.asPrisma() },
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      TenantResolver,
      TenantScopeFactory,
      AuditService,
      UserScopeGuard,
      UserScopeFactory,
      UserDirectory,
      TenantTransactionRunner,
      OrganizationsService,
      ...(extraProviders ?? []),
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('v1');
  // Exactly what main.ts installs.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AppExceptionFilter());
  await app.init();
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    async call(method, path, options): Promise<HttpResult> {
      const headers: Record<string, string> = {};
      if (options?.as) headers.cookie = `${SESSION_COOKIE}=${options.as}`;
      if (options?.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    },
  };
}
