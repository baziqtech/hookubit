import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { IDS, seedWorld } from '../../authz/testing/fixtures';
import { FakeTenantPrisma } from '../../authz/testing/tenant-prisma.fake';
import { hashApiKey } from '../../common/api-key';
import { AppExceptionFilter } from '../../common/errors';
import { ThrottleGuard } from '../../common/throttle.guard';
import { InMemoryThrottleStore, THROTTLE_STORE } from '../../common/throttle.store';
import { ApiKeysController } from '../api-keys.controller';
import { ApiKeysService } from '../api-keys.service';

/**
 * Same shape as the projects harness: a real Nest app with the real guards and
 * the real `ValidationPipe` settings from main.ts, over the in-memory tenant
 * fake. `PrismaService` is never imported here either - the providers are
 * constructed around the fake - so the eslint ban that keeps feature modules
 * off the unscoped client holds for the tests as well.
 */
class StubSessionService {
  async verify(token: string): Promise<SessionUser | null> {
    if (!token.startsWith('usr_')) return null;
    return { userId: token, email: `${token}@example.com`, sessionId: `ses_${token}` };
  }
}

export const KEY_IDS = {
  /** Live in project A1. */
  activeA: 'key_a_active',
  /** Revoked, in project A1 - must still be listed, labelled. */
  revokedA: 'key_a_revoked',
  /** Expired, in project A1. */
  expiredA: 'key_a_expired',
  /** Project B's key. Never visible to org A, by id or in a listing. */
  foreignB: 'key_b_active',
} as const;

export interface HttpResult<T> {
  status: number;
  body: T & { error?: { code: string; message: string; details?: Record<string, unknown> } };
}

export interface HarnessOptions {
  /** `MAX_API_KEYS_PER_PROJECT` for this app. */
  maxKeys?: number;
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

const PAST = new Date('2026-01-01T00:00:00.000Z');

/**
 * Prisma column defaults the fake does not implement (`scopes []`, the three
 * nullable timestamps, `created_at`/`updated_at`, and the two nullable
 * `created_by_*` provenance columns). Without them a freshly created row has
 * `revokedAt: undefined`, which is not a state the real column can be in, and
 * every status derivation downstream would be tested against a shape production
 * cannot produce. `createdBy*` defaults to NULL for the same reason: that is
 * what a pre-migration row and a row whose issuer was deleted both look like.
 */
export function enforceApiKeySchema(db: FakeTenantPrisma): void {
  const create = db.apiKey.create;
  db.apiKey.create = async (args: { data: Record<string, unknown> }) =>
    create({
      data: {
        scopes: [],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdByUserId: null,
        createdByMembershipId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      },
    });
}

function seedKeys(db: FakeTenantPrisma): void {
  const base = {
    scopes: [] as string[],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    // Seeded keys predate the provenance columns, exactly like the rows the
    // migration's backfill could not recover an issuer for.
    createdByUserId: null,
    createdByMembershipId: null,
    createdAt: PAST,
    updatedAt: PAST,
  };
  db.insert('apiKey', {
    ...base,
    id: KEY_IDS.activeA,
    projectId: IDS.projectA1,
    name: 'seeded active',
    keyHash: hashApiKey('wk_test_seededActiveKeyForProjectA1x'),
    keyPrefix: 'wk_test_seed',
    environment: 'test',
  });
  db.insert('apiKey', {
    ...base,
    id: KEY_IDS.revokedA,
    projectId: IDS.projectA1,
    name: 'seeded revoked',
    keyHash: hashApiKey('wk_test_seededRevokedKeyForProjectA1'),
    keyPrefix: 'wk_test_revo',
    environment: 'test',
    revokedAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  db.insert('apiKey', {
    ...base,
    id: KEY_IDS.expiredA,
    projectId: IDS.projectA1,
    name: 'seeded expired',
    keyHash: hashApiKey('wk_test_seededExpiredKeyForProjectA1'),
    keyPrefix: 'wk_test_expi',
    environment: 'test',
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  db.insert('apiKey', {
    ...base,
    id: KEY_IDS.foreignB,
    projectId: IDS.projectB1,
    name: 'globex ingest',
    keyHash: hashApiKey('wk_test_seededKeyForProjectB1xxxxx'),
    keyPrefix: 'wk_test_glob',
    environment: 'test',
  });
}

export async function startApiKeysApp(options: HarnessOptions = {}): Promise<Harness> {
  const db = seedWorld();
  enforceApiKeySchema(db);
  seedKeys(db);
  // `live` so the wk_live_ path is exercised somewhere real.
  const liveProject = db.rows('project').get(IDS.projectA2);
  if (liveProject) liveProject.environment = 'live';
  const prisma = db.asPrisma();

  const moduleRef = await Test.createTestingModule({
    controllers: [ApiKeysController],
    providers: [
      ApiKeysService,
      { provide: SessionService, useClass: StubSessionService },
      SessionGuard,
      TenantGuard,
      { provide: TenantResolver, useValue: new TenantResolver(prisma) },
      { provide: TenantScopeFactory, useValue: new TenantScopeFactory(prisma) },
      { provide: AuditService, useValue: new AuditService(prisma) },
      ThrottleGuard,
      // Fresh per app; see the projects harness for why a shared counter would
      // leak a tripped bucket between tests.
      { provide: THROTTLE_STORE, useValue: new InMemoryThrottleStore() },
      {
        provide: ConfigService,
        useValue: new ConfigService(
          options.maxKeys === undefined
            ? {}
            : { MAX_API_KEYS_PER_PROJECT: String(options.maxKeys) },
        ),
      },
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
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    },
    close: () => app.close(),
  };
}
