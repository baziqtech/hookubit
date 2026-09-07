import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { SessionGuard } from '../../auth/session.guard';
import { SESSION_COOKIE, SessionService, SessionUser } from '../../auth/session.service';
import {
  AuditService,
  TenantGuard,
  TenantResolver,
  TenantScopeFactory,
} from '../../authz';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { seedWorld } from '../../authz/testing/fixtures';
import { AppExceptionFilter } from '../../common/errors';
import { ThrottleGuard } from '../../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../../common/throttle.store';
import { ProjectsController } from '../projects.controller';
import { ProjectsService } from '../projects.service';

/**
 * The projects module as a browser meets it: real Nest, real routing, the real
 * `ValidationPipe` configuration from main.ts, the real guards mounted by
 * `@Authorized`, and the real exception filter turning `AppError` into a status
 * code and a body.
 *
 * Only `SessionService` is stubbed - the cookie is a bare user id - because
 * authentication has its own suite and substituting it keeps these tests about
 * tenancy and about projects.
 *
 * Note what is NOT provided: `PrismaService`. The providers are constructed
 * around the fake directly, so this file does not import the unscoped client
 * and `.eslintrc.json`'s ban stays meaningful for the whole module, tests
 * included.
 */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

export interface HttpResult<T> {
  status: number;
  body: T & { error?: { code: string; message: string; details?: Record<string, unknown> } };
}

export interface HarnessOptions {
  /**
   * `MAX_PROJECTS_PER_ORGANIZATION` for this app. Provided through a real
   * `ConfigService` rather than by stubbing the limits function, so the parse,
   * the clamp and the lookup are all exercised by the ceiling tests.
   */
  maxProjects?: number;
}

export interface Harness {
  app: INestApplication;
  db: FakeTenantPrisma;
  call<T>(
    method: string,
    path: string,
    options?: { as?: string; body?: unknown },
  ): Promise<HttpResult<T>>;
  close(): Promise<void>;
}

/**
 * `projects (organization_id, slug)` is UNIQUE in PostgreSQL, and the fake has
 * no indexes: without this the slug-collision tests would pass vacuously by
 * inserting a second row instead of raising P2002.
 *
 * It also stamps `created_at`/`updated_at`, which Prisma fills from
 * `@default(now())`/`@updatedAt` and the fake does not - the response mapper
 * reads them, so a row without them is not a row production could produce.
 */
export function enforceProjectSchema(db: FakeTenantPrisma): void {
  for (const row of db.rows('project').values()) {
    row.createdAt = row.createdAt ?? new Date('2026-01-01T00:00:00.000Z');
    row.updatedAt = row.updatedAt ?? new Date('2026-01-01T00:00:00.000Z');
  }

  const create = db.project.create;
  const updateMany = db.project.updateMany;
  const findMany = db.project.findMany;

  db.project.create = async (args: { data: Record<string, unknown> }) => {
    if (
      db
        .all('project')
        .some(
          (row) =>
            row.organizationId === args.data.organizationId && row.slug === args.data.slug,
        )
    ) {
      throw uniqueViolation(['organization_id', 'slug']);
    }
    return create({
      // Column defaults Prisma applies and the fake does not: `status
      // @default(active)`, `created_at`, `updated_at`. A row without them is
      // not a row production could produce, and the response mapper reads them.
      data: {
        status: 'active',
        environment: 'test',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      },
    });
  };

  db.project.updateMany = async (args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => {
    const nextSlug = args.data.slug;
    if (typeof nextSlug === 'string') {
      const targets = await findMany({ where: args.where });
      for (const target of targets) {
        const clash = db
          .all('project')
          .some(
            (row) =>
              row.id !== target.id &&
              row.organizationId === target.organizationId &&
              row.slug === nextSlug,
          );
        if (clash) throw uniqueViolation(['organization_id', 'slug']);
      }
    }
    return updateMany({ ...args, data: { ...args.data, updatedAt: new Date() } });
  };
}

/** A P2002 in the shape Prisma really raises, so the detector is tested honestly. */
export function uniqueViolation(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`organization_id`,`slug`)',
    { code: 'P2002', clientVersion: '5.22.0', meta: { target } },
  );
}

export async function startProjectsApp(options: HarnessOptions = {}): Promise<Harness> {
  const db = seedWorld();
  enforceProjectSchema(db);
  const prisma = db.asPrisma();

  const moduleRef = await Test.createTestingModule({
    controllers: [ProjectsController],
    providers: [
      ProjectsService,
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      { provide: TenantResolver, useValue: new TenantResolver(prisma) },
      { provide: TenantScopeFactory, useValue: new TenantScopeFactory(prisma) },
      { provide: AuditService, useValue: new AuditService(prisma) },
      ThrottleGuard,
      // A FRESH store per app: the in-memory counter is keyed by client address
      // and every test in this file calls from 127.0.0.1, so a shared store
      // would leak a tripped bucket from one test into the next.
      { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
      {
        provide: ConfigService,
        useValue: new ConfigService(
          options.maxProjects === undefined
            ? {}
            : { MAX_PROJECTS_PER_ORGANIZATION: String(options.maxProjects) },
        ),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  // Exactly main.ts: the `environment`-is-immutable rule leans on
  // forbidNonWhitelisted, so a harness without it would prove nothing.
  app.setGlobalPrefix('v1');
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
    db,
    async call<T>(
      method: string,
      path: string,
      options?: { as?: string; body?: unknown },
    ): Promise<HttpResult<T>> {
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
    close: () => app.close(),
  };
}
