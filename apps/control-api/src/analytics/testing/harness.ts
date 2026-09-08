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
import { AnalyticsController } from '../analytics.controller';
import { AnalyticsService } from '../analytics.service';
import { withRankedGroupBy } from './aggregate-fake';

/**
 * A fixture whose every number is known by hand.
 *
 * Analytics tests that only assert shape are worthless: the failure this module
 * can actually ship is a right-shaped response carrying somebody else's totals,
 * or its own totals off by the rows that sit just outside the window. So the
 * counts below are chosen, written down in `EXPECTED`, and asserted as exact
 * integers - and every count has decoys sitting one step outside it: rows in
 * the previous window, rows older than both windows, rows in a sibling project,
 * and rows in another organization.
 */
/**
 * The clock the fixture is built around, and it is the REAL one.
 *
 * A frozen literal would have been tidier, but `AnalyticsService` resolves its
 * window from `new Date()` when nothing is passed - which is what the
 * controller does - so a fixture pinned to a date in the past is invisible to
 * every HTTP test. Faking the system clock is worse: these tests run a real
 * Nest app on a real socket, and `jest.useFakeTimers` around that is a source
 * of flakes far more interesting than the ones it prevents.
 *
 * So the fixture is placed RELATIVE to now, with hours of margin either side of
 * every boundary: in-window rows sit 1-21 hours back, previous-window rows
 * 26-32 hours back, and the decoys a year back. Test execution moving the clock
 * by milliseconds cannot move a row across a boundary.
 */
export const NOW = new Date();

/** Inside the 24h window. */
function recent(hoursAgo: number): Date {
  return new Date(NOW.getTime() - hoursAgo * 3_600_000);
}

/** Inside the PREVIOUS 24h window, i.e. 24-48 hours ago. */
function previous(hoursAgo: number): Date {
  return recent(24 + hoursAgo);
}

/** Older than both windows. Must never be counted. */
const ANCIENT = new Date(NOW.getTime() - 365 * 24 * 3_600_000);

export const ANALYTICS = {
  /** Project A1's endpoints. `endpointA1` comes from `seedWorld`. */
  endpointQuiet: IDS.endpointA1,
  endpointPayments: 'ep_a_payments',
  endpointLedger: 'ep_a_ledger',
  /** Project A2 - same organization, different project. */
  endpointOtherProject: 'ep_a2',
  /** A project in organization A with nothing in it at all. */
  projectEmpty: 'proj_a_empty',
} as const;

/**
 * Every number the assertions use, derived here once so a fixture change that
 * invalidates a count cannot leave a stale literal in a spec file.
 */
export const EXPECTED = {
  window: {
    /** ep_quiet 3 + ep_payments 2 + ep_ledger 5 */
    succeeded: 10,
    /** ep_quiet 1 + ep_payments 4 */
    failed: 5,
    /** ep_payments 3 + ep_ledger 2 */
    exhausted: 5,
    /** ep_payments 1 */
    retrying: 1,
    total: 21,
    failing: 10,
    inFlight: 1,
    /** succeeded / (succeeded + failed + exhausted) = 10 / 20 */
    successRate: 0.5,
  },
  previous: {
    succeeded: 4,
    failed: 1,
    total: 5,
    /** 4 / 5 */
    successRate: 0.8,
  },
  events: {
    total: 12,
    previousTotal: 3,
    byType: [
      { event_type: 'order.created', count: 6 },
      { event_type: 'payment.settled', count: 4 },
      { event_type: 'refund.issued', count: 2 },
    ],
  },
  /**
   * Ten measured attempts on in-window deliveries, ascending. Nearest rank:
   * p50 = ceil(0.50 x 10) = 5th  = 50
   * p95 = ceil(0.95 x 10) = 10th = 1000
   * p99 = ceil(0.99 x 10) = 10th = 1000
   */
  latency: {
    durations: [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000],
    p50: 50,
    p95: 1000,
    p99: 1000,
    min: 10,
    max: 1000,
    sampleSize: 10,
  },
} as const;

function endpoint(db: FakeTenantPrisma, id: string, projectId: string, extra: Row = {}): void {
  db.insert('endpoint', {
    id,
    projectId,
    name: id,
    url: `https://${id}.example.com/hook`,
    description: null,
    status: 'active',
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    timeoutMs: 30_000,
    maxConcurrency: 16,
    rateLimit: null,
    rateLimitWindowSeconds: 1,
    retryPolicyId: null,
    customHeaders: null,
    createdAt: ANCIENT,
    updatedAt: ANCIENT,
    ...extra,
  });
}

let deliverySequence = 0;

function delivery(
  db: FakeTenantPrisma,
  options: {
    endpointId: string;
    status: string;
    createdAt: Date;
    projectId?: string;
    organizationId?: string;
    eventId?: string;
    durationMs?: number | null;
  },
): string {
  deliverySequence += 1;
  const id = `del_an_${String(deliverySequence).padStart(3, '0')}`;
  db.insert('delivery', {
    id,
    eventId: options.eventId ?? IDS.eventA1,
    endpointId: options.endpointId,
    subscriptionId: null,
    organizationId: options.organizationId ?? IDS.orgA,
    projectId: options.projectId ?? IDS.projectA1,
    status: options.status,
    attemptCount: 1,
    maxAttempts: 8,
    nextAttemptAt: null,
    lastAttemptAt: options.createdAt,
    completedAt: null,
    orderingKey: null,
    lockedBy: null,
    lockedUntil: null,
    replayOfDeliveryId: null,
    replayedBy: null,
    lastError: null,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  });
  if (options.durationMs !== undefined) {
    db.insert('deliveryAttempt', {
      id: `att_an_${String(deliverySequence).padStart(3, '0')}`,
      deliveryId: id,
      attemptNumber: 1,
      startedAt: options.createdAt,
      completedAt: options.createdAt,
      status: 'success',
      httpStatus: 200,
      requestHeaders: null,
      responseHeaders: null,
      responseBody: null,
      responseBodyLocation: null,
      responseSize: null,
      errorCode: null,
      errorMessage: null,
      durationMs: options.durationMs,
      workerId: 'worker-1',
      createdAt: options.createdAt,
    });
  }
  return id;
}

let eventSequence = 0;

function event(
  db: FakeTenantPrisma,
  eventType: string,
  createdAt: Date,
  projectId: string = IDS.projectA1,
  organizationId: string = IDS.orgA,
): void {
  eventSequence += 1;
  db.insert('event', {
    id: `evt_an_${String(eventSequence).padStart(3, '0')}`,
    organizationId,
    projectId,
    eventType,
    idempotencyKey: null,
    payloadRaw: null,
    payload: null,
    payloadLocation: null,
    payloadSize: 0,
    payloadHash: 'sha256-x',
    orderingKey: null,
    headers: null,
    status: 'processed',
    createdAt,
    processedAt: createdAt,
  });
}

/**
 * The rows `seedWorld` created carry no `created_at`, and a window filter on a
 * NULL timestamp matches nothing - so they would fall outside every window by
 * accident. Pinning them to a date older than both windows makes that
 * deliberate: they are decoys that prove the lower bound is enforced, not rows
 * that happen to be invisible.
 */
function ageSeedWorldRows(db: FakeTenantPrisma): void {
  for (const table of ['delivery', 'event'] as const) {
    for (const row of db.all(table)) {
      db.rows(table).set(String(row.id), { ...row, createdAt: ANCIENT, updatedAt: ANCIENT });
    }
  }
  for (const row of db.all('deliveryAttempt')) {
    db.rows('deliveryAttempt').set(String(row.id), {
      startedAt: ANCIENT,
      completedAt: ANCIENT,
      status: 'failure',
      httpStatus: 500,
      // 99_999 is loud on purpose: if it ever reaches a percentile, the
      // assertion names the row that leaked rather than being merely off.
      durationMs: 99_999,
      ...row,
      createdAt: ANCIENT,
    });
  }
  for (const row of db.all('endpoint')) {
    db.rows('endpoint').set(String(row.id), {
      enabled: true,
      disabledReason: null,
      status: 'active',
      createdAt: ANCIENT,
      updatedAt: ANCIENT,
      ...row,
    });
  }
}

export function seedAnalytics(db: FakeTenantPrisma = seedWorld()): FakeTenantPrisma {
  deliverySequence = 0;
  eventSequence = 0;
  ageSeedWorldRows(db);

  db.insert('project', {
    id: ANALYTICS.projectEmpty,
    organizationId: IDS.orgA,
    name: 'empty',
    slug: 'empty',
    environment: 'test',
    status: 'active',
  });

  endpoint(db, ANALYTICS.endpointPayments, IDS.projectA1);
  endpoint(db, ANALYTICS.endpointLedger, IDS.projectA1);
  endpoint(db, ANALYTICS.endpointOtherProject, IDS.projectA2);

  // --- the window ---------------------------------------------------------
  // Latency sample: ten measured attempts, one per delivery, spread across the
  // three endpoints so the sample is not an artefact of one of them.
  const durations = [...EXPECTED.latency.durations];

  const take = (): number => {
    const value = durations.shift();
    if (value === undefined) throw new Error('analytics fixture: ran out of durations');
    return value;
  };

  // ep_quiet: 3 succeeded, 1 failed.
  delivery(db, { endpointId: ANALYTICS.endpointQuiet, status: 'succeeded', createdAt: recent(1), durationMs: take() });
  delivery(db, { endpointId: ANALYTICS.endpointQuiet, status: 'succeeded', createdAt: recent(2), durationMs: take() });
  delivery(db, { endpointId: ANALYTICS.endpointQuiet, status: 'succeeded', createdAt: recent(3) });
  delivery(db, { endpointId: ANALYTICS.endpointQuiet, status: 'failed', createdAt: recent(4), durationMs: take() });

  // ep_payments: the culprit. 2 succeeded, 4 failed, 3 exhausted, 1 retrying.
  delivery(db, { endpointId: ANALYTICS.endpointPayments, status: 'succeeded', createdAt: recent(5), durationMs: take() });
  delivery(db, { endpointId: ANALYTICS.endpointPayments, status: 'succeeded', createdAt: recent(6), durationMs: take() });
  for (let index = 0; index < 4; index += 1) {
    delivery(db, {
      endpointId: ANALYTICS.endpointPayments,
      status: 'failed',
      createdAt: recent(7 + index),
      durationMs: index < 2 ? take() : undefined,
    });
  }
  for (let index = 0; index < 3; index += 1) {
    delivery(db, {
      endpointId: ANALYTICS.endpointPayments,
      status: 'exhausted',
      createdAt: recent(11 + index),
      durationMs: index < 2 ? take() : undefined,
    });
  }
  delivery(db, { endpointId: ANALYTICS.endpointPayments, status: 'retrying', createdAt: recent(14) });

  // ep_ledger: 5 succeeded, 2 exhausted.
  for (let index = 0; index < 5; index += 1) {
    delivery(db, {
      endpointId: ANALYTICS.endpointLedger,
      status: 'succeeded',
      createdAt: recent(15 + index),
      durationMs: index < 1 ? take() : undefined,
    });
  }
  delivery(db, { endpointId: ANALYTICS.endpointLedger, status: 'exhausted', createdAt: recent(20) });
  // An attempt with NO measured duration. `duration_ms` is nullable and the
  // worker leaves it null when it never got far enough to time anything; a
  // percentile that counted it as 0 would report a latency improvement caused
  // by an outage.
  delivery(db, {
    endpointId: ANALYTICS.endpointLedger,
    status: 'exhausted',
    createdAt: recent(21),
    durationMs: null,
  });

  if (durations.length !== 0) {
    throw new Error(`analytics fixture: ${durations.length} duration(s) never placed`);
  }

  // --- the previous window ------------------------------------------------
  for (let index = 0; index < 4; index += 1) {
    delivery(db, {
      endpointId: ANALYTICS.endpointQuiet,
      status: 'succeeded',
      createdAt: previous(2 + index),
      durationMs: 5_000,
    });
  }
  delivery(db, {
    endpointId: ANALYTICS.endpointQuiet,
    status: 'failed',
    createdAt: previous(8),
    durationMs: 5_000,
  });

  // --- older than both ----------------------------------------------------
  delivery(db, { endpointId: ANALYTICS.endpointQuiet, status: 'succeeded', createdAt: ANCIENT, durationMs: 7_000 });
  delivery(db, { endpointId: ANALYTICS.endpointQuiet, status: 'exhausted', createdAt: ANCIENT, durationMs: 7_000 });

  // --- the sibling project, IN the window ---------------------------------
  // Six failures that must never appear in project A1's numbers, on an endpoint
  // that would otherwise rank first.
  for (let index = 0; index < 6; index += 1) {
    delivery(db, {
      endpointId: ANALYTICS.endpointOtherProject,
      status: 'failed',
      createdAt: recent(1),
      projectId: IDS.projectA2,
      durationMs: 8_888,
    });
  }

  // --- another organization, IN the window --------------------------------
  for (let index = 0; index < 9; index += 1) {
    delivery(db, {
      endpointId: IDS.endpointB1,
      status: 'exhausted',
      createdAt: recent(1),
      projectId: IDS.projectB1,
      organizationId: IDS.orgB,
      eventId: IDS.eventB1,
      durationMs: 9_999,
    });
  }

  // --- events -------------------------------------------------------------
  for (let index = 0; index < 6; index += 1) event(db, 'order.created', recent(1 + index));
  for (let index = 0; index < 4; index += 1) event(db, 'payment.settled', recent(8 + index));
  for (let index = 0; index < 2; index += 1) event(db, 'refund.issued', recent(13 + index));
  for (let index = 0; index < 3; index += 1) event(db, 'order.created', previous(3 + index));
  // Decoys: same window, wrong tenant.
  for (let index = 0; index < 7; index += 1) event(db, 'order.created', recent(2), IDS.projectA2);
  for (let index = 0; index < 5; index += 1) {
    event(db, 'order.created', recent(2), IDS.projectB1, IDS.orgB);
  }

  return db;
}

// ---------------------------------------------------------------------------
// Service harness
// ---------------------------------------------------------------------------

export interface AnalyticsHarness {
  db: FakeTenantPrisma;
  context: RequestContext;
  analytics: AnalyticsService;
}

/**
 * The service, with a context built by resolving a real request through
 * `TenantResolver`. A hand-made `RequestContext` could be wrong in the caller's
 * favour and every isolation test below would pass anyway.
 */
export async function analyticsHarness(
  userId: string = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
  db: FakeTenantPrisma = seedAnalytics(),
): Promise<AnalyticsHarness> {
  const prisma = withRankedGroupBy(db);
  const resolver = new TenantResolver(prisma);
  const context = await resolver.resolve(
    sessionUser(userId),
    requestWith(params, userId),
    DEFAULT_TENANT_SPEC,
  );
  return { db, context, analytics: new AnalyticsService(new TenantScopeFactory(prisma)) };
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
  call<T>(method: string, path: string, options?: { as?: string }): Promise<HttpResult<T>>;
  close(): Promise<void>;
}

export const analyticsPath = (projectId: string): string =>
  `/v1/projects/${projectId}/analytics`;

/**
 * A real Nest app with the real guards, the real `ValidationPipe` settings from
 * main.ts and the real exception filter, over the in-memory fixture.
 * `PrismaService` is never imported by the module under test - the providers
 * are constructed around the fake - so the fence that keeps feature modules off
 * the unscoped client holds for these tests too.
 */
export async function startAnalyticsApp(
  db: FakeTenantPrisma = seedAnalytics(),
): Promise<HttpHarness> {
  const prisma = withRankedGroupBy(db);
  const scopes = new TenantScopeFactory(prisma);

  const moduleRef = await Test.createTestingModule({
    // `DiscoveryModule` is what `assertRoutesAreGuarded` walks; without it the
    // "no route serves unauthenticated" check would pass by not looking.
    imports: [DiscoveryModule],
    controllers: [AnalyticsController],
    providers: [
      AnalyticsService,
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      { provide: TenantResolver, useValue: new TenantResolver(prisma) },
      { provide: TenantScopeFactory, useValue: scopes },
      { provide: AuditService, useValue: new AuditService(prisma) },
      ThrottleGuard,
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
      options?: { as?: string },
    ): Promise<HttpResult<T>> {
      const headers: Record<string, string> = {};
      if (options?.as) headers.cookie = `${SESSION_COOKIE}=${options.as}`;
      const response = await fetch(`${baseUrl}${path}`, { method, headers });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: (text ? JSON.parse(text) : {}) as HttpResult<T>['body'],
      };
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}
