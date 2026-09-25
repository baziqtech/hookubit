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
import { EventsController } from '../../events/events.controller';
import { EventsService } from '../../events/events.service';
import { TenantTransactionRunner } from '../../organizations/tenant-transaction';
import { DeliveriesController } from '../deliveries.controller';
import { DeliveriesService } from '../deliveries.service';
import { MAX_INLINE_ATTEMPTS, MAX_REPLAY_DELIVERIES } from '../delivery-limits';
import { DeliveryReplayService } from '../delivery-replay.service';
import { installRichTables } from './rich-fake';

/**
 * A delivery ledger with the shapes that actually turn up at 2am.
 *
 * `seedWorld` gives two tenants and one skeletal event/delivery/attempt each;
 * everything below is what this module has to be able to explain: a succeeded
 * delivery, an exhausted one, one mid-retry, one pointing at a soft-deleted
 * endpoint, one at a paused endpoint, a delivery with more attempts than fit in
 * a response, an offloaded payload, a payload that is not valid UTF-8, an event
 * that matched nothing at all, and an event whose routing is wider than a
 * single replay is allowed to re-send.
 *
 * Project A2 and organization B are seeded with matching rows throughout: a
 * test proving a listing returned A1's deliveries is only worth something if
 * A2's and B's were sitting in the same table and did not come back.
 */
export const LEDGER = {
  /** The trace the worker kept for attempt 1 of `deliveryOrderA1`. 32 hex. */
  attemptA1TraceId: '4bf92f3577b34da6a3ce929d0e0e4736',

  // --- endpoints (project A1) ---------------------------------------------
  endpointA1: IDS.endpointA1,
  endpointFinance: 'ep_a_finance',
  endpointDeleted: 'ep_a_deleted',
  endpointPaused: 'ep_a_paused',

  // --- events (project A1) ------------------------------------------------
  /** order.created, delivered to two endpoints. The clean replay-to-all case. */
  eventOrder: IDS.eventA1,
  /** payment.settled. One live endpoint, one soft-deleted. */
  eventSettled: 'evt_a_settled',
  /** Payload offloaded to object storage: payload_raw IS NULL by design. */
  eventOffloaded: 'evt_a_big',
  /** payload_raw is not valid UTF-8. */
  eventBinary: 'evt_a_binary',
  /** A body far longer than the preview bound, and longer than the read slice. */
  eventLongBody: 'evt_a_long',
  /** All 3-byte characters, so the byte slice lands INSIDE a code point. */
  eventMultibyte: 'evt_a_multibyte',
  /** Matched no subscription. Nothing to replay. */
  eventOrphan: 'evt_a_orphan',
  /** Routed wider than MAX_REPLAY_DELIVERIES. */
  eventWide: 'evt_a_wide',
  /** Project A2 - same organization, different project. */
  eventOtherProject: 'evt_a2_1',

  // --- deliveries (project A1) --------------------------------------------
  /** eventOrder -> endpointA1, succeeded after 2 attempts. */
  deliveryOrderA1: IDS.deliveryA1,
  /** eventOrder -> endpointFinance, exhausted. 12 attempts. */
  deliveryOrderFinance: 'del_a_finance',
  /** eventSettled -> endpointA1, retrying. */
  deliverySettledA1: 'del_a_settled',
  /** eventSettled -> endpointDeleted. A replay of this must be refused. */
  deliverySettledGone: 'del_a_settled_gone',
  /** eventOffloaded -> endpointPaused. A replay of this must be refused. */
  deliveryPaused: 'del_a_paused',
  /** eventBinary -> endpointFinance, with more attempts than fit inline. */
  deliveryNoisy: 'del_a_noisy',
  /** eventLongBody -> endpointA1, succeeded. */
  deliveryLongBody: 'del_a_long',
  /** eventMultibyte -> endpointA1, succeeded. */
  deliveryMultibyte: 'del_a_multibyte',
} as const;

/** Attempts on `deliveryOrderFinance`. Crosses the 9 -> 10 ordering boundary. */
export const FINANCE_ATTEMPTS = 12;
/** Attempts on `deliveryNoisy`. Past the inline cap, so a page is truncated. */
export const NOISY_ATTEMPTS = MAX_INLINE_ATTEMPTS + 5;
/** Endpoints `eventWide` reached. Past the routing cap. */
export const WIDE_ENDPOINTS = MAX_REPLAY_DELIVERIES + 5;

export const T = {
  order: new Date('2026-03-01T10:00:00.000Z'),
  settled: new Date('2026-03-02T10:00:00.000Z'),
  offloaded: new Date('2026-03-03T10:00:00.000Z'),
  binary: new Date('2026-03-04T10:00:00.000Z'),
  orphan: new Date('2026-03-05T10:00:00.000Z'),
  wide: new Date('2026-03-06T10:00:00.000Z'),
  long: new Date('2026-03-07T10:00:00.000Z'),
  multibyte: new Date('2026-03-08T10:00:00.000Z'),
} as const;

const ORDER_BODY = '{"order_id":"41f9","amount":1250,"currency":"GHS"}';
const SETTLED_BODY = '{ "b": 2,\n  "a": 1 }';
/** 0xff 0xfe is not valid UTF-8; decoding it as UTF-8 would give U+FFFD soup. */
export const BINARY_PAYLOAD = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x7f]);

/**
 * 2011 ASCII bytes: longer than `PAYLOAD_PREVIEW_MAX_CHARS` AND longer than
 * `PAYLOAD_PREVIEW_READ_BYTES`, so the preview is capped by the character bound
 * AND the database slice really cut something off.
 */
export const LONG_BODY = `{"note":"${'a'.repeat(2_000)}"}`;

/**
 * A body of nothing but U+20AC (3 bytes each), 900 bytes long.
 *
 * `PAYLOAD_PREVIEW_READ_BYTES` is 640, and 640 is not a multiple of 3: the slice
 * ends one byte into the 214th character. That is the case a naive
 * `Buffer.toString('utf8')` renders with a trailing U+FFFD.
 */
export const MULTIBYTE_CHAR = '€';
export const MULTIBYTE_BODY = MULTIBYTE_CHAR.repeat(300);

function endpoint(db: FakeTenantPrisma, id: string, projectId: string, extra: Row = {}): void {
  db.insert('endpoint', {
    id,
    projectId,
    name: id,
    url: `https://${id}.example.com/hook`,
    status: 'active',
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    timeoutMs: 30_000,
    maxConcurrency: 16,
    createdAt: T.order,
    updatedAt: T.order,
    ...extra,
  });
}

function event(db: FakeTenantPrisma, id: string, projectId: string, extra: Row): void {
  const body = String(extra.body ?? ORDER_BODY);
  const raw = extra.payloadRaw === undefined ? Buffer.from(body, 'utf8') : extra.payloadRaw;
  const rest = { ...extra };
  delete rest.body;
  db.insert('event', {
    id,
    organizationId: projectId === IDS.projectB1 ? IDS.orgB : IDS.orgA,
    projectId,
    eventType: 'order.created',
    idempotencyKey: null,
    payloadRaw: raw,
    payload: null,
    payloadLocation: null,
    payloadSize: raw instanceof Uint8Array ? raw.byteLength : 0,
    payloadHash: `sha256-of-${id}`,
    orderingKey: null,
    headers: null,
    status: 'processed',
    createdAt: T.order,
    processedAt: T.order,
    ...rest,
  });
}

function delivery(db: FakeTenantPrisma, id: string, extra: Row): void {
  db.insert('delivery', {
    id,
    subscriptionId: null,
    organizationId: IDS.orgA,
    projectId: IDS.projectA1,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 8,
    // NOT NULL in the schema (20260911000000) and defaulted to the insert
    // time; a seed that left it null would model a row PostgreSQL rejects.
    nextAttemptAt: T.order,
    lastAttemptAt: null,
    completedAt: null,
    orderingKey: null,
    lockedBy: null,
    lockedUntil: null,
    replayOfDeliveryId: null,
    replayedBy: null,
    lastError: null,
    createdAt: T.order,
    updatedAt: T.order,
    ...extra,
  });
}

function attempt(db: FakeTenantPrisma, id: string, deliveryId: string, number: number, extra: Row = {}): void {
  db.insert('deliveryAttempt', {
    id,
    deliveryId,
    attemptNumber: number,
    startedAt: new Date(T.order.getTime() + number * 1000),
    completedAt: new Date(T.order.getTime() + number * 1000 + 400),
    status: 'failure',
    httpStatus: 500,
    requestHeaders: null,
    // The default attempt has no recorded body, which is the honest shape for a
    // row written before `request_payload` existed or pruned since.
    requestPayload: null,
    responseHeaders: null,
    responseBody: null,
    responseBodyLocation: null,
    responseSize: null,
    errorCode: 'http_500',
    errorMessage: 'upstream said no',
    durationMs: 400,
    workerId: 'worker-1',
    // The worker writes this only for a SAMPLED span; the common attempt has
    // none, and the DTO must say null rather than invent one.
    traceId: null,
    createdAt: new Date(T.order.getTime() + number * 1000 + 400),
    ...extra,
  });
}

/**
 * Columns the schema declares NOT NULL that `seedWorld` does not set, because
 * `src/authz` never renders a row and its fixture carries only what the tenant
 * predicates read. A seeded row without them is a shape the database cannot
 * produce, and letting a response mapper tolerate it would be testing against
 * impossible input.
 */
function backfill(db: FakeTenantPrisma): void {
  for (const row of db.all('endpoint')) {
    db.rows('endpoint').set(String(row.id), {
      enabled: true,
      disabledReason: null,
      status: 'active',
      createdAt: T.order,
      updatedAt: T.order,
      ...row,
    });
  }
  for (const row of db.all('event')) {
    const raw = Buffer.from(ORDER_BODY, 'utf8');
    db.rows('event').set(String(row.id), {
      idempotencyKey: null,
      payloadRaw: raw,
      payload: null,
      payloadLocation: null,
      payloadSize: raw.byteLength,
      payloadHash: `sha256-of-${String(row.id)}`,
      orderingKey: null,
      headers: null,
      status: 'processed',
      createdAt: T.order,
      processedAt: T.order,
      ...row,
    });
  }
  for (const row of db.all('delivery')) {
    db.rows('delivery').set(String(row.id), {
      subscriptionId: null,
      attemptCount: 0,
      maxAttempts: 8,
      nextAttemptAt: T.order,
      lastAttemptAt: null,
      completedAt: null,
      orderingKey: null,
      lockedBy: null,
      lockedUntil: null,
      replayOfDeliveryId: null,
      replayedBy: null,
      lastError: null,
      createdAt: T.order,
      updatedAt: T.order,
      ...row,
    });
  }
  for (const row of db.all('deliveryAttempt')) {
    db.rows('deliveryAttempt').set(String(row.id), {
      startedAt: T.order,
      completedAt: T.order,
      status: 'failure',
      httpStatus: 500,
      durationMs: 10,
      createdAt: T.order,
      ...row,
    });
  }
}

export function seedLedger(db: FakeTenantPrisma = seedWorld()): FakeTenantPrisma {
  backfill(db);
  installRichTables(db);

  endpoint(db, LEDGER.endpointFinance, IDS.projectA1);
  endpoint(db, LEDGER.endpointDeleted, IDS.projectA1, { status: 'deleted' });
  endpoint(db, LEDGER.endpointPaused, IDS.projectA1, { status: 'paused', enabled: false });

  // --- events -------------------------------------------------------------
  db.rows('event').set(LEDGER.eventOrder, {
    ...(db.rows('event').get(LEDGER.eventOrder) as Row),
    eventType: 'order.created',
    idempotencyKey: 'idem-order-0001',
    payload: { order_id: '41f9', amount: 1250, currency: 'GHS' },
    headers: { 'content-type': 'application/json', authorization: 'Bearer wk_live_supersecret' },
    createdAt: T.order,
    processedAt: T.order,
  });

  event(db, LEDGER.eventSettled, IDS.projectA1, {
    eventType: 'payment.settled',
    idempotencyKey: 'idem-ORDER-41F9',
    body: SETTLED_BODY,
    // jsonb NORMALISES: keys sorted, whitespace gone. Different bytes from the
    // raw body above, which is the entire point of keeping both.
    payload: { a: 1, b: 2 },
    createdAt: T.settled,
    processedAt: T.settled,
  });

  event(db, LEDGER.eventOffloaded, IDS.projectA1, {
    eventType: 'report.generated',
    payloadRaw: null,
    payloadLocation: 's3://payloads/proj_a1/evt_a_big.json',
    payloadSize: 4_194_304,
    payload: null,
    createdAt: T.offloaded,
    processedAt: T.offloaded,
  });

  event(db, LEDGER.eventBinary, IDS.projectA1, {
    eventType: 'file.uploaded',
    payloadRaw: BINARY_PAYLOAD,
    payloadSize: BINARY_PAYLOAD.byteLength,
    createdAt: T.binary,
    processedAt: T.binary,
  });

  event(db, LEDGER.eventLongBody, IDS.projectA1, {
    eventType: 'ledger.exported',
    body: LONG_BODY,
    createdAt: T.long,
    processedAt: T.long,
  });

  event(db, LEDGER.eventMultibyte, IDS.projectA1, {
    eventType: 'ledger.multibyte',
    body: MULTIBYTE_BODY,
    createdAt: T.multibyte,
    processedAt: T.multibyte,
  });

  event(db, LEDGER.eventOrphan, IDS.projectA1, {
    eventType: 'ghost.emitted',
    status: 'processed',
    createdAt: T.orphan,
    processedAt: T.orphan,
  });

  event(db, LEDGER.eventWide, IDS.projectA1, {
    eventType: 'broadcast.sent',
    createdAt: T.wide,
    processedAt: T.wide,
  });

  event(db, LEDGER.eventOtherProject, IDS.projectA2, {
    eventType: 'order.created',
    idempotencyKey: 'idem-order-0001',
    createdAt: T.settled,
  });

  // --- deliveries ---------------------------------------------------------
  db.rows('delivery').set(LEDGER.deliveryOrderA1, {
    ...(db.rows('delivery').get(LEDGER.deliveryOrderA1) as Row),
    eventId: LEDGER.eventOrder,
    endpointId: LEDGER.endpointA1,
    subscriptionId: IDS.subscriptionA1,
    status: 'succeeded',
    attemptCount: 2,
    maxAttempts: 8,
    completedAt: T.order,
    lastAttemptAt: T.order,
    orderingKey: 'customer-7',
    createdAt: T.order,
  });

  delivery(db, LEDGER.deliveryOrderFinance, {
    eventId: LEDGER.eventOrder,
    endpointId: LEDGER.endpointFinance,
    status: 'exhausted',
    attemptCount: FINANCE_ATTEMPTS,
    maxAttempts: FINANCE_ATTEMPTS,
    lastAttemptAt: T.order,
    completedAt: T.order,
    lastError: 'giving up after 12 attempts',
    createdAt: T.order,
  });

  delivery(db, LEDGER.deliverySettledA1, {
    eventId: LEDGER.eventSettled,
    endpointId: LEDGER.endpointA1,
    status: 'retrying',
    attemptCount: 3,
    nextAttemptAt: new Date('2026-03-02T10:30:00.000Z'),
    lastAttemptAt: T.settled,
    lastError: 'connection reset',
    createdAt: T.settled,
  });

  delivery(db, LEDGER.deliverySettledGone, {
    eventId: LEDGER.eventSettled,
    endpointId: LEDGER.endpointDeleted,
    status: 'failed',
    attemptCount: 1,
    lastError: 'endpoint deleted',
    createdAt: T.settled,
  });

  delivery(db, LEDGER.deliveryPaused, {
    eventId: LEDGER.eventOffloaded,
    endpointId: LEDGER.endpointPaused,
    status: 'pending',
    createdAt: T.offloaded,
  });

  delivery(db, LEDGER.deliveryNoisy, {
    eventId: LEDGER.eventBinary,
    endpointId: LEDGER.endpointFinance,
    status: 'retrying',
    attemptCount: NOISY_ATTEMPTS,
    maxAttempts: 200,
    createdAt: T.binary,
  });

  delivery(db, LEDGER.deliveryLongBody, {
    eventId: LEDGER.eventLongBody,
    endpointId: LEDGER.endpointA1,
    status: 'succeeded',
    attemptCount: 1,
    completedAt: T.long,
    lastAttemptAt: T.long,
    createdAt: T.long,
  });

  delivery(db, LEDGER.deliveryMultibyte, {
    eventId: LEDGER.eventMultibyte,
    endpointId: LEDGER.endpointA1,
    status: 'succeeded',
    attemptCount: 1,
    completedAt: T.multibyte,
    lastAttemptAt: T.multibyte,
    createdAt: T.multibyte,
  });

  // --- attempts -----------------------------------------------------------
  db.rows('deliveryAttempt').set(IDS.attemptA1, {
    ...(db.rows('deliveryAttempt').get(IDS.attemptA1) as Row),
    deliveryId: LEDGER.deliveryOrderA1,
    attemptNumber: 1,
    status: 'failure',
    httpStatus: 503,
    requestHeaders: {
      'content-type': 'application/json',
      'x-webhook-signature': 'v1,abc123',
      authorization: 'Bearer customer-token-do-not-leak',
    },
    // What the worker stored: a BOUNDED copy of what this attempt sent, marked
    // where it was cut. The exact bytes are on the event.
    requestPayload: '{"order_id":"ord_9","tot\n…[truncated]',
    responseHeaders: { 'retry-after': '30' },
    responseBody: 'service unavailable',
    responseSize: 19,
    errorCode: 'http_503',
    errorMessage: 'service unavailable',
    durationMs: 1_204,
    // This attempt's span was sampled, so the worker kept its trace id.
    traceId: LEDGER.attemptA1TraceId,
  });
  attempt(db, 'att_a1_2', LEDGER.deliveryOrderA1, 2, {
    status: 'success',
    httpStatus: 200,
    // Small enough to be stored whole, and byte-identical to attempt 1's body:
    // the signature covers the raw bytes, so a retry cannot send anything else.
    requestPayload: '{"order_id":"ord_9","total":1200}',
    errorCode: null,
    errorMessage: null,
    responseBody: 'ok',
    responseSize: 2,
    durationMs: 88,
  });

  for (let number = 1; number <= FINANCE_ATTEMPTS; number += 1) {
    attempt(db, `att_fin_${number}`, LEDGER.deliveryOrderFinance, number);
  }
  for (let number = 1; number <= NOISY_ATTEMPTS; number += 1) {
    attempt(db, `att_noisy_${String(number).padStart(4, '0')}`, LEDGER.deliveryNoisy, number);
  }

  // --- the wide routing ---------------------------------------------------
  for (let index = 0; index < WIDE_ENDPOINTS; index += 1) {
    const id = `ep_wide_${String(index).padStart(3, '0')}`;
    endpoint(db, id, IDS.projectA1);
    delivery(db, `del_wide_${String(index).padStart(3, '0')}`, {
      eventId: LEDGER.eventWide,
      endpointId: id,
      status: 'succeeded',
      createdAt: T.wide,
    });
  }

  // --- other tenants ------------------------------------------------------
  delivery(db, 'del_a2_1', {
    eventId: LEDGER.eventOtherProject,
    endpointId: LEDGER.endpointA1,
    projectId: IDS.projectA2,
    status: 'succeeded',
    createdAt: T.settled,
  });

  return db;
}

// ---------------------------------------------------------------------------
// Service harness
// ---------------------------------------------------------------------------

export interface LedgerHarness {
  db: FakeTenantPrisma;
  context: RequestContext;
  scopes: TenantScopeFactory;
  audit: AuditService;
  transactions: TenantTransactionRunner;
  replays: DeliveryReplayService;
  deliveries: DeliveriesService;
  events: EventsService;
}

/**
 * The services, wired the way production wires them, with the context built by
 * resolving a real request through `TenantResolver`. A hand-made context could
 * be wrong in the caller's favour and every isolation test would pass anyway.
 */
export async function ledgerHarness(
  userId: string = IDS.ownerA,
  params: Record<string, string> = { orgId: IDS.orgA, projectId: IDS.projectA1 },
  db: FakeTenantPrisma = seedLedger(),
): Promise<LedgerHarness> {
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
  const replays = new DeliveryReplayService(transactions);
  const deliveries = new DeliveriesService(scopes, replays);
  const events = new EventsService(scopes, deliveries, replays);

  return { db, context, scopes, audit, transactions, replays, deliveries, events };
}

/** A delivery row straight out of storage, for before/after comparison. */
export function rawDelivery(db: FakeTenantPrisma, id: string): Row {
  const row = db.rows('delivery').get(id);
  if (!row) throw new Error(`no delivery ${id} in the fixture`);
  return { ...row };
}

/** Every delivery row, as stored. */
export function allDeliveries(db: FakeTenantPrisma): Row[] {
  return db.all('delivery').map((row) => ({ ...row }));
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
 * main.ts and the real exception filter, over the in-memory ledger.
 * `PrismaService` is never imported - the providers are constructed around the
 * fake - so the eslint fence that keeps feature modules off the unscoped client
 * holds for the tests as well.
 *
 * BOTH controllers, in one app: `GET /events/:id/deliveries` is served by the
 * events controller out of the deliveries service, and mounting them separately
 * would test a wiring that does not exist.
 */
export async function startLedgerApp(db: FakeTenantPrisma = seedLedger()): Promise<HttpHarness> {
  const prisma = db.asPrisma();
  const scopes = new TenantScopeFactory(prisma);
  const audit = new AuditService(prisma);
  const transactions = new SerializableTransactionRunner(db, scopes, audit);

  const moduleRef = await Test.createTestingModule({
    // `DiscoveryModule` is what `assertRoutesAreGuarded` walks: without it the
    // "every route with authorization metadata has an enforcing guard" check
    // cannot see the controllers and would pass by not looking.
    imports: [DiscoveryModule],
    controllers: [DeliveriesController, EventsController],
    providers: [
      DeliveriesService,
      DeliveryReplayService,
      EventsService,
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      { provide: TenantResolver, useValue: new TenantResolver(prisma) },
      { provide: TenantScopeFactory, useValue: scopes },
      { provide: AuditService, useValue: audit },
      { provide: TenantTransactionRunner, useValue: transactions },
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

export const DELIVERIES_PATH = `/v1/projects/${IDS.projectA1}/deliveries`;
export const EVENTS_PATH = `/v1/projects/${IDS.projectA1}/events`;
