import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { SessionGuard } from '../../auth/session.guard';
import { SESSION_COOKIE, SessionService, SessionUser } from '../../auth/session.service';
import {
  AuditService,
  DEFAULT_TENANT_SPEC,
  RequestContext,
  TenantGuard,
  TenantResolver,
  TenantScopeFactory,
} from '../../authz';
import { IDS, requestWith, seedWorld, sessionUser } from '../../authz/testing/fixtures';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { AppExceptionFilter } from '../../common/errors';
import { ThrottleGuard } from '../../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../../common/throttle.store';
// The serial-schedule stand-in for SERIALIZABLE, borrowed rather than
// re-implemented: two implementations of "the transaction the concurrency tests
// run under" is one more than can be reviewed, and this suite's whole ceiling
// argument depends on it behaving the way the real runner does.
import { SerializableTransactionRunner } from '../../endpoint-secrets/testing/harness';
import { TenantTransactionRunner } from '../../organizations/tenant-transaction';
import { WebhookSubscriptionsController } from '../webhook-subscriptions.controller';
import { WebhookSubscriptionsService } from '../webhook-subscriptions.service';

/**
 * Fixture ids this module adds on top of `seedWorld`.
 *
 * `seedWorld` already seeds ONE subscription (`sub_a1`, project A1, `["*"]`).
 * Every isolation test here is "actor from A asks for the B-shaped row", so the
 * B-side subscription and a second A-side endpoint are seeded too - a test that
 * proves a listing returns A's subscriptions is only meaningful if B's was
 * sitting in the same table and did not come back.
 */
export const SUB_IDS = {
  /** Project A1, endpoint A1, `["*"]`, enabled. From `seedWorld`. */
  a1: IDS.subscriptionA1,
  /** Project A1, endpoint A2, filtered and DISABLED. */
  a2: 'sub_a2',
  /** Project B1. Never visible to org A, by id or in a listing. */
  b1: 'sub_b1',
  /** A second endpoint in project A1, so re-pointing has somewhere to go. */
  endpointA2: 'ep_a2',
  /** A soft-deleted endpoint in project A1. Cannot be subscribed to. */
  endpointADeleted: 'ep_a_deleted',
} as const;

const PAST = new Date('2026-01-01T00:00:00.000Z');

/**
 * PostgreSQL turns `Prisma.DbNull` into SQL NULL, and a `Json?` column reads
 * back as `null`. The in-memory fake stores whatever it is handed, so a row
 * written with `payloadFilter: Prisma.DbNull` reads back as the SENTINEL
 * OBJECT - a value the real column can never hold, and one that
 * `toSubscriptionDto` would then be under pressure to tolerate.
 *
 * Modelled here rather than in the response mapper, deliberately. Making
 * production code tolerant of an impossible shape to satisfy a fixture is how a
 * mapper ends up quietly accepting a filter it should have refused; this keeps
 * it a fixture limitation, in the same spirit as `enforceApiKeySchema`.
 */
function normaliseJsonNull(data: Record<string, unknown>): Record<string, unknown> {
  const value = data.payloadFilter;
  if (value === Prisma.DbNull || value === Prisma.JsonNull || value === Prisma.AnyNull) {
    return { ...data, payloadFilter: null };
  }
  return data;
}

function enforceSubscriptionSchema(db: FakeTenantPrisma): void {
  const create = db.webhookSubscription.create;
  db.webhookSubscription.create = async (args: { data: Record<string, unknown> }) =>
    create({ data: normaliseJsonNull(args.data) });

  const updateMany = db.webhookSubscription.updateMany;
  db.webhookSubscription.updateMany = async (args: {
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => updateMany({ where: args.where, data: normaliseJsonNull(args.data) });
}

/**
 * Columns the schema declares `NOT NULL DEFAULT ...` that `seedWorld` does not
 * set, because `src/authz` never renders a row and its fixture only carries what
 * the tenant predicates read. A seeded row without them is a shape the database
 * cannot produce, and letting the response mapper tolerate it would be testing
 * against impossible input.
 */
export function seedSubscriptions(db: FakeTenantPrisma): FakeTenantPrisma {
  enforceSubscriptionSchema(db);
  for (const table of ['endpoint', 'webhookSubscription'] as const) {
    for (const row of db.all(table)) {
      db.rows(table).set(String(row.id), {
        createdAt: PAST,
        updatedAt: PAST,
        ...(table === 'webhookSubscription'
          ? { name: null, payloadFilter: null, enabled: true }
          : {}),
        ...row,
      });
    }
  }

  db.insert('endpoint', {
    id: SUB_IDS.endpointA2,
    projectId: IDS.projectA1,
    name: 'a2',
    url: 'https://a2.example.com/hook',
    status: 'active',
    createdAt: PAST,
    updatedAt: PAST,
  });
  db.insert('endpoint', {
    id: SUB_IDS.endpointADeleted,
    projectId: IDS.projectA1,
    name: 'a-deleted',
    url: 'https://gone.example.com/hook',
    status: 'deleted',
    createdAt: PAST,
    updatedAt: PAST,
  });

  db.insert('webhookSubscription', {
    id: SUB_IDS.a2,
    projectId: IDS.projectA1,
    endpointId: SUB_IDS.endpointA2,
    name: 'settlements only',
    eventTypes: ['payment.settled'],
    payloadFilter: null,
    enabled: false,
    createdAt: PAST,
    updatedAt: PAST,
  });
  db.insert('webhookSubscription', {
    id: SUB_IDS.b1,
    projectId: IDS.projectB1,
    endpointId: IDS.endpointB1,
    name: 'globex everything',
    eventTypes: ['*'],
    payloadFilter: null,
    enabled: true,
    createdAt: PAST,
    updatedAt: PAST,
  });

  return db;
}

export interface Harness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  audit: AuditService;
  transactions: TenantTransactionRunner;
  config: ConfigService;
  subscriptions: WebhookSubscriptionsService;
}

export interface HarnessOptions {
  /** `MAX_SUBSCRIPTIONS_PER_PROJECT` for this harness. */
  maxSubscriptions?: number;
  db?: FakeTenantPrisma;
}

function configFor(maxSubscriptions?: number): ConfigService {
  return new ConfigService(
    maxSubscriptions === undefined
      ? {}
      : { MAX_SUBSCRIPTIONS_PER_PROJECT: String(maxSubscriptions) },
  );
}

/**
 * The service, wired the way production wires it: the context is built by
 * resolving a real request through `TenantResolver` against the shared
 * two-tenant fixture, not hand-made. A hand-made context could be wrong in the
 * caller's favour and the isolation tests would never notice.
 */
export async function harnessFor(
  userId: string = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
  options: HarnessOptions = {},
): Promise<Harness> {
  const db = seedSubscriptions(options.db ?? seedWorld());
  const prisma = db.asPrisma();
  const resolver = new TenantResolver(prisma);
  const context = await resolver.resolve(
    sessionUser(userId),
    requestWith(params, userId),
    DEFAULT_TENANT_SPEC,
  );

  const scopes = new TenantScopeFactory(prisma);
  const audit = new AuditService(prisma);
  const transactions = new SerializableTransactionRunner(db, scopes, audit);
  const config = configFor(options.maxSubscriptions);
  const subscriptions = new WebhookSubscriptionsService(scopes, audit, transactions, config);

  return { db, context, scopes, audit, transactions, config, subscriptions };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

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

export interface HttpHarness {
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
 * A real Nest app with the real guards, the real `ValidationPipe` settings from
 * main.ts and the real exception filter, over the in-memory tenant fake.
 * `PrismaService` is never imported - the providers are constructed around the
 * fake - so the eslint ban that keeps feature modules off the unscoped client
 * holds for the tests as well.
 */
export async function startSubscriptionsApp(
  options: HarnessOptions = {},
): Promise<HttpHarness> {
  const db = seedSubscriptions(options.db ?? seedWorld());
  const prisma = db.asPrisma();
  const scopes = new TenantScopeFactory(prisma);
  const audit = new AuditService(prisma);

  const moduleRef = await Test.createTestingModule({
    controllers: [WebhookSubscriptionsController],
    providers: [
      WebhookSubscriptionsService,
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      { provide: TenantResolver, useValue: new TenantResolver(prisma) },
      { provide: TenantScopeFactory, useValue: scopes },
      { provide: AuditService, useValue: audit },
      {
        provide: TenantTransactionRunner,
        useValue: new SerializableTransactionRunner(db, scopes, audit),
      },
      ThrottleGuard,
      // Fresh per app: a shared counter would leak a tripped bucket from the
      // throttle test into every suite that ran after it.
      { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
      { provide: ConfigService, useValue: configFor(options.maxSubscriptions) },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
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
      callOptions?: { as?: string; body?: unknown },
    ): Promise<HttpResult<T>> {
      const headers: Record<string, string> = {};
      if (callOptions?.as) headers.cookie = `${SESSION_COOKIE}=${callOptions.as}`;
      if (callOptions?.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: callOptions?.body === undefined ? undefined : JSON.stringify(callOptions.body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    },
    close: () => app.close(),
  };
}

/** `/v1/projects/:projectId/subscriptions`, for the project the tests use. */
export const SUBSCRIPTIONS_PATH = `/v1/projects/${IDS.projectA1}/subscriptions`;
