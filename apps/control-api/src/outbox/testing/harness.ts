import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
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
import { FakeTenantPrisma, Row } from '../../authz/testing/tenant-prisma.fake';
import { AppExceptionFilter } from '../../common/errors';
import { ThrottleGuard } from '../../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../../common/throttle.store';
// The serial-schedule stand-in for SERIALIZABLE, borrowed rather than
// re-implemented, for the reason the subscriptions harness gives: two
// implementations of "the transaction the concurrency tests run under" is one
// more than can be reviewed.
import { SerializableTransactionRunner } from '../../endpoint-secrets/testing/harness';
import { OutboxController } from '../outbox.controller';
import { OutboxService } from '../outbox.service';

/**
 * The outbox as it actually looks after an incident.
 *
 * `seedWorld` gives two tenants; everything below is the set of states this
 * module has to be able to explain and act on: a row that completed, a row
 * parked because it kept killing the router, a row parked after failing for
 * longer than its retry duration, a row parked HALFWAY through a wide routing
 * (cursor set, so a requeue must resume rather than restart), a row currently
 * leased by a router, a row waiting in its backoff - and parked rows belonging
 * to the neighbouring project and the neighbouring organization, so that a test
 * proving a listing returned A1's rows is worth something.
 */
export const OUTBOX = {
  /** Routed cleanly. Requeueing it is a 409 pointing at replay. */
  processed: 'obx_a_done',
  /** PARKED: claimed past ROUTER_MAX_OUTBOX_ATTEMPTS with no recorded outcome. */
  parkedPoison: 'obx_a_poison',
  /** PARKED: recorded failures for longer than MaxOutboxRetryDuration. */
  parkedStale: 'obx_a_stale',
  /** PARKED mid-routing. `routing_cursor` is set; some endpoints already have deliveries. */
  parkedMidRouting: 'obx_a_partial',
  /** Leased by a router right now. Requeueing it is a 409. */
  processing: 'obx_a_leased',
  /** Queued and backing off. Requeueing it is a 409. */
  pending: 'obx_a_pending',
  /** Project A2 - same organization, different project. */
  parkedOtherProject: 'obx_a2_parked',
  /** Organization B. */
  parkedOtherOrg: 'obx_b_parked',
} as const;

export const OUTBOX_EVENTS = {
  processed: 'evt_obx_done',
  parkedPoison: 'evt_obx_poison',
  parkedStale: 'evt_obx_stale',
  parkedMidRouting: 'evt_obx_partial',
  processing: 'evt_obx_leased',
  pending: 'evt_obx_pending',
  parkedOtherProject: 'evt_obx_a2',
  parkedOtherOrg: 'evt_obx_b',
} as const;

export const T = {
  done: new Date('2026-03-01T10:00:00.000Z'),
  poison: new Date('2026-03-02T10:00:00.000Z'),
  stale: new Date('2026-03-03T10:00:00.000Z'),
  partial: new Date('2026-03-04T10:00:00.000Z'),
  leased: new Date('2026-03-05T10:00:00.000Z'),
  pending: new Date('2026-03-06T10:00:00.000Z'),
} as const;

function event(db: FakeTenantPrisma, id: string, organizationId: string, projectId: string, extra: Row): void {
  const raw = Buffer.from('{"order_id":"41f9"}', 'utf8');
  db.insert('event', {
    id,
    organizationId,
    projectId,
    eventType: 'payment.settled',
    idempotencyKey: null,
    payloadRaw: raw,
    payload: null,
    payloadLocation: null,
    payloadSize: raw.byteLength,
    payloadHash: `sha256-of-${id}`,
    orderingKey: null,
    headers: null,
    status: 'received',
    createdAt: T.done,
    processedAt: null,
    ...extra,
  });
}

function outbox(db: FakeTenantPrisma, id: string, eventId: string, extra: Row): void {
  db.insert('eventOutbox', {
    id,
    eventId,
    type: 'event.created',
    status: 'pending',
    attempts: 0,
    unaccountedAttempts: 0,
    failingSince: null,
    routingCursor: null,
    availableAt: T.done,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
    processedAt: null,
    createdAt: T.done,
    ...extra,
  });
}

export function seedOutbox(db: FakeTenantPrisma = seedWorld()): FakeTenantPrisma {
  // --- project A1 ---------------------------------------------------------
  event(db, OUTBOX_EVENTS.processed, IDS.orgA, IDS.projectA1, {
    status: 'processed',
    createdAt: T.done,
    processedAt: T.done,
  });
  outbox(db, OUTBOX.processed, OUTBOX_EVENTS.processed, {
    status: 'processed',
    attempts: 1,
    processedAt: T.done,
    createdAt: T.done,
  });

  event(db, OUTBOX_EVENTS.parkedPoison, IDS.orgA, IDS.projectA1, {
    status: 'failed',
    createdAt: T.poison,
    processedAt: T.poison,
  });
  outbox(db, OUTBOX.parkedPoison, OUTBOX_EVENTS.parkedPoison, {
    status: 'failed',
    attempts: 11,
    unaccountedAttempts: 11,
    lastError: 'attempts_exhausted: claimed 11 times (11 of them leaving no recorded outcome, bound 10)',
    processedAt: T.poison,
    createdAt: T.poison,
  });

  event(db, OUTBOX_EVENTS.parkedStale, IDS.orgA, IDS.projectA1, {
    status: 'failed',
    createdAt: T.stale,
    processedAt: T.stale,
  });
  outbox(db, OUTBOX.parkedStale, OUTBOX_EVENTS.parkedStale, {
    status: 'failed',
    attempts: 63,
    unaccountedAttempts: 0,
    failingSince: T.stale,
    lastError: 'retry_duration_exceeded: failing since 2026-03-03T10:00:00Z (1h2m0s, bound 1h0m0s)',
    processedAt: T.stale,
    createdAt: T.stale,
  });

  event(db, OUTBOX_EVENTS.parkedMidRouting, IDS.orgA, IDS.projectA1, {
    status: 'failed',
    createdAt: T.partial,
    processedAt: T.partial,
  });
  outbox(db, OUTBOX.parkedMidRouting, OUTBOX_EVENTS.parkedMidRouting, {
    status: 'failed',
    attempts: 14,
    unaccountedAttempts: 11,
    routingCursor: 'sub_01HALFWAY',
    lastError: 'attempts_exhausted: claimed 14 times (11 of them leaving no recorded outcome, bound 10)',
    processedAt: T.partial,
    createdAt: T.partial,
  });

  event(db, OUTBOX_EVENTS.processing, IDS.orgA, IDS.projectA1, {
    status: 'processing',
    createdAt: T.leased,
  });
  outbox(db, OUTBOX.processing, OUTBOX_EVENTS.processing, {
    status: 'processing',
    attempts: 1,
    unaccountedAttempts: 1,
    lockedBy: 'wrk_01ROUTER',
    lockedUntil: new Date(T.leased.getTime() + 60_000),
    createdAt: T.leased,
  });

  event(db, OUTBOX_EVENTS.pending, IDS.orgA, IDS.projectA1, {
    status: 'processing',
    createdAt: T.pending,
  });
  outbox(db, OUTBOX.pending, OUTBOX_EVENTS.pending, {
    status: 'pending',
    attempts: 3,
    unaccountedAttempts: 0,
    failingSince: T.pending,
    lastError: 'connection reset by peer',
    availableAt: new Date(T.pending.getTime() + 30_000),
    createdAt: T.pending,
  });

  // --- the neighbours -----------------------------------------------------
  event(db, OUTBOX_EVENTS.parkedOtherProject, IDS.orgA, IDS.projectA2, {
    status: 'failed',
    createdAt: T.poison,
  });
  outbox(db, OUTBOX.parkedOtherProject, OUTBOX_EVENTS.parkedOtherProject, {
    status: 'failed',
    attempts: 11,
    unaccountedAttempts: 11,
    lastError: 'attempts_exhausted',
    createdAt: T.poison,
  });

  event(db, OUTBOX_EVENTS.parkedOtherOrg, IDS.orgB, IDS.projectB1, {
    status: 'failed',
    createdAt: T.poison,
  });
  outbox(db, OUTBOX.parkedOtherOrg, OUTBOX_EVENTS.parkedOtherOrg, {
    status: 'failed',
    attempts: 11,
    unaccountedAttempts: 11,
    lastError: 'attempts_exhausted',
    createdAt: T.poison,
  });

  return db;
}

/** When the bulk fixture's rows were parked. After every date in `T`. */
export const BULK_PARKED_AT = new Date('2026-04-01T10:00:00.000Z');

/**
 * `count` more parked rows in project A1, on top of whatever `db` already holds.
 *
 * The incident that parks rows parks them in bulk, and the properties that only
 * appear at a full page - the bound, `has_more`, and the statement count of the
 * transaction the operator is waiting on - cannot be exercised by the three rows
 * `seedOutbox` provides. Every row carries `attempts: 11`, so a bulk requeue can
 * be asserted not to have flattened the counter the operator UI reads.
 */
export function seedParkedBulk(db: FakeTenantPrisma, count: number): FakeTenantPrisma {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, '0');
    event(db, `evt_bulk_${suffix}`, IDS.orgA, IDS.projectA1, {
      status: 'failed',
      createdAt: BULK_PARKED_AT,
      processedAt: BULK_PARKED_AT,
    });
    outbox(db, `obx_bulk_${suffix}`, `evt_bulk_${suffix}`, {
      status: 'failed',
      attempts: 11,
      unaccountedAttempts: 11,
      lastError: 'attempts_exhausted',
      availableAt: BULK_PARKED_AT,
      processedAt: BULK_PARKED_AT,
      createdAt: BULK_PARKED_AT,
    });
  }
  return db;
}

// ---------------------------------------------------------------------------
// Service harness
// ---------------------------------------------------------------------------

export interface OutboxHarness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  audit: AuditService;
  outbox: OutboxService;
}

/**
 * The service, wired the way production wires it, with the context built by
 * resolving a real request through `TenantResolver`. A hand-made context could
 * be wrong in the caller's favour and every isolation test would pass anyway.
 */
export async function outboxHarness(
  userId: string = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
  db: FakeTenantPrisma = seedOutbox(),
): Promise<OutboxHarness> {
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

  return { db, context, scopes, audit, outbox: new OutboxService(scopes, transactions) };
}

/** An outbox row straight out of storage, for before/after comparison. */
export function rawOutbox(db: FakeTenantPrisma, id: string): Row {
  const row = db.rows('eventOutbox').get(id);
  if (!row) throw new Error(`no outbox row ${id} in the fixture`);
  return { ...row };
}

export function rawEvent(db: FakeTenantPrisma, id: string): Row {
  const row = db.rows('event').get(id);
  if (!row) throw new Error(`no event ${id} in the fixture`);
  return { ...row };
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
  headers: Headers;
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
 * main.ts and the real exception filter, over the in-memory fixture.
 * `PrismaService` is never imported - the providers are constructed around the
 * fake - so the eslint fence that keeps feature modules off the unscoped client
 * holds for the tests as well.
 */
export async function startOutboxApp(db: FakeTenantPrisma = seedOutbox()): Promise<HttpHarness> {
  const prisma = db.asPrisma();
  const scopes = new TenantScopeFactory(prisma);
  const audit = new AuditService(prisma);
  const transactions = new SerializableTransactionRunner(db, scopes, audit);

  const moduleRef = await Test.createTestingModule({
    // `DiscoveryModule` is what `assertRoutesAreGuarded` walks: without it the
    // "every route with authorization metadata has an enforcing guard" check
    // cannot see the controller and would pass by not looking.
    imports: [DiscoveryModule],
    controllers: [OutboxController],
    providers: [
      { provide: OutboxService, useValue: new OutboxService(scopes, transactions) },
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      { provide: TenantResolver, useValue: new TenantResolver(prisma) },
      { provide: TenantScopeFactory, useValue: scopes },
      { provide: AuditService, useValue: audit },
      ThrottleGuard,
      // Fresh per app: a shared counter would leak a tripped bucket from the
      // throttle test into every suite that ran after it.
      { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
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
      return {
        status: response.status,
        headers: response.headers,
        body: text ? JSON.parse(text) : {},
      };
    },
    close: () => app.close(),
  };
}

export const OUTBOX_PATH = `/v1/projects/${IDS.projectA1}/outbox`;
