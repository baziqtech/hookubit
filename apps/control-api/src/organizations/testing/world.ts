import { UserToken, UserTokenType } from '@prisma/client';
import { RequestContext, TenantResolver } from '../../authz';
import { TenantRequest } from '../../authz/tenant-context';
import { FakeTenantPrisma, Row } from '../../authz/testing/tenant-prisma.fake';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { UserPrincipal } from '../user-scope';

/**
 * The in-memory world these two modules are tested against.
 *
 * `FakeTenantPrisma` already does the one thing the authorization tests need -
 * a WHERE evaluator that really filters, so an isolation test cannot pass
 * vacuously - and it is composed rather than subclassed here so its delegates
 * stay exactly as the authz suite exercises them. Four things are added, each
 * because a behaviour under test depends on it:
 *
 *  1. **`user_tokens`.** The invitation flow uses the real `TokenService`, so
 *     the fake has to reproduce the conditional UPDATE that makes consumption
 *     single-use. Mirrors `auth/testing/prisma.fake.ts`.
 *  2. **Unique constraints** on `organizations.slug` and
 *     `organization_members (organization_id, user_id)`, shaped like a real
 *     P2002 with `meta.target`. The slug retry in `OrganizationsService.create`
 *     is a branch on that target; a fake without it would let the wrong branch
 *     pass.
 *  3. **Rollback on `$transaction`.** "The create path is atomic" is not a
 *     claim a fake that never rolls back can test.
 *  4. **A transaction log.** The role lattice's owner count MUST be taken
 *     inside the transaction that writes, or two concurrent demotions each see
 *     two owners and leave zero. `transactions` records which statements ran
 *     inside which transaction so a test can assert it, rather than trusting a
 *     comment.
 *
 * Test files only; never imported by application code.
 */

export interface RecordedStatement {
  table: string;
  op: string;
}

export type FakeDelegate = FakeTenantPrisma['organization'];
type Delegate = FakeDelegate;

function uniqueViolation(target: string): Error {
  const err = new Error(`Unique constraint failed on ${target}`) as Error & {
    code: string;
    meta: { target: string[] };
  };
  err.code = 'P2002';
  err.meta = { target: [target] };
  return err;
}

export class FakeWorld {
  private readonly inner = new FakeTenantPrisma();
  private readonly tokens = new Map<string, UserToken>();
  private depth = 0;

  /** One entry per top-level `$transaction`, holding the statements it ran. */
  readonly transactions: RecordedStatement[][] = [];

  readonly user: Delegate = this.inner.user;
  readonly project: Delegate = this.inner.project;
  readonly auditLog: Delegate = this.inner.auditLog;

  /** Rows written here get the columns PostgreSQL would default. */
  readonly organization: Delegate = {
    ...this.inner.organization,
    updateMany: async (args: { where?: Row; data: Row }): Promise<{ count: number }> => {
      if (typeof args.data.slug === 'string') {
        const targets = new Set(
          (await this.inner.organization.findMany({ where: args.where })).map((row) =>
            String(row.id),
          ),
        );
        for (const row of this.inner.all('organization')) {
          if (!targets.has(String(row.id)) && row.slug === args.data.slug) {
            throw uniqueViolation('slug');
          }
        }
      }
      return this.inner.organization.updateMany(args);
    },
    create: async (args: { data: Row }): Promise<Row> => {
      const slug = String(args.data.slug);
      for (const row of this.inner.all('organization')) {
        if (row.slug === slug) throw uniqueViolation('slug');
      }
      return this.inner.organization.create({
        data: {
          status: 'active',
          planId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
        },
      });
    },
  };

  readonly organizationMember: Delegate = {
    ...this.inner.organizationMember,
    create: async (args: { data: Row }): Promise<Row> => {
      for (const row of this.inner.all('organizationMember')) {
        if (
          row.organizationId === args.data.organizationId &&
          row.userId === args.data.userId
        ) {
          throw uniqueViolation('organization_id');
        }
      }
      return this.inner.organizationMember.create({
        data: { createdAt: new Date(), updatedAt: new Date(), ...args.data },
      });
    },
  };

  /** Only what `TokenService` issues, consumes and revokes. */
  readonly userToken = {
    create: async (args: { data: Row }): Promise<UserToken> => {
      const token = {
        userId: null,
        metadata: null,
        consumedAt: null,
        createdAt: new Date(),
        ...args.data,
      } as unknown as UserToken;
      for (const existing of this.tokens.values()) {
        if (existing.tokenHash === token.tokenHash) throw uniqueViolation('token_hash');
      }
      this.tokens.set(token.id, token);
      return { ...token };
    },
    findUnique: async (args: { where: { tokenHash: string } }): Promise<UserToken | null> => {
      for (const token of this.tokens.values()) {
        if (token.tokenHash === args.where.tokenHash) return { ...token };
      }
      return null;
    },
    /** The conditional UPDATE that makes consumption single-use. */
    updateMany: async (args: {
      where: {
        tokenHash?: string;
        email?: string;
        type?: UserTokenType;
        consumedAt?: null;
        expiresAt?: { gt: Date };
      };
      data: { consumedAt: Date };
    }): Promise<{ count: number }> => {
      const { where, data } = args;
      let count = 0;
      for (const [id, token] of this.tokens) {
        if (where.tokenHash !== undefined && token.tokenHash !== where.tokenHash) continue;
        if (where.email !== undefined && token.email !== where.email) continue;
        if (where.type !== undefined && token.type !== where.type) continue;
        if (where.consumedAt === null && token.consumedAt !== null) continue;
        if (where.expiresAt && token.expiresAt.getTime() <= where.expiresAt.gt.getTime()) continue;
        this.tokens.set(id, { ...token, consumedAt: data.consumedAt });
        count += 1;
      }
      return { count };
    },
  };

  /**
   * Rolls back on failure and records what ran inside. Re-entrant, because
   * `ScopedRepository.updateById` opens its own transaction when handed a
   * client that has `$transaction` - only the outermost one is a boundary.
   */
  async $transaction<T>(fn: (tx: FakeWorld) => Promise<T>): Promise<T> {
    const outermost = this.depth === 0;
    const snapshot = outermost ? this.snapshot() : null;
    const from = this.inner.queries.length;
    this.depth += 1;
    try {
      const result = await fn(this);
      return result;
    } catch (err) {
      if (snapshot) this.restore(snapshot);
      throw err;
    } finally {
      this.depth -= 1;
      if (outermost) {
        this.transactions.push(
          this.inner.queries
            .slice(from)
            .map((entry) => ({ table: entry.table, op: entry.op })),
        );
      }
    }
  }

  // --- seeding and assertion helpers --------------------------------------

  insert(table: string, row: Row): Row {
    return this.inner.insert(table as Parameters<FakeTenantPrisma['insert']>[0], row);
  }

  all(table: string): Row[] {
    return this.inner.all(table as Parameters<FakeTenantPrisma['all']>[0]);
  }

  rows(table: string): Map<string, Row> {
    return this.inner.rows(table as Parameters<FakeTenantPrisma['rows']>[0]);
  }

  tokenRows(): UserToken[] {
    return [...this.tokens.values()];
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  private snapshot(): { tables: Map<string, Map<string, Row>>; tokens: Map<string, UserToken> } {
    const tables = new Map<string, Map<string, Row>>();
    for (const [name, rows] of this.inner.tables) tables.set(name, new Map(rows));
    return { tables, tokens: new Map(this.tokens) };
  }

  private restore(snapshot: {
    tables: Map<string, Map<string, Row>>;
    tokens: Map<string, UserToken>;
  }): void {
    for (const [name, rows] of snapshot.tables) {
      const live = this.inner.tables.get(name);
      if (!live) continue;
      live.clear();
      for (const [id, row] of rows) live.set(id, row);
    }
    this.tokens.clear();
    for (const [id, token] of snapshot.tokens) this.tokens.set(id, token);
  }
}

export const IDS = {
  orgA: 'org_a',
  orgB: 'org_b',
  orgDeleted: 'org_gone',

  ownerA: 'usr_owner_a',
  secondOwnerA: 'usr_owner2_a',
  adminA: 'usr_admin_a',
  developerA: 'usr_dev_a',
  viewerA: 'usr_viewer_a',
  ownerB: 'usr_owner_b',
  /** Has an account, belongs to no organization. The invitee. */
  outsider: 'usr_outsider',
  /** Has an account and belongs to org B. The "arbitrary platform user id". */
  strangerB: 'usr_stranger_b',
} as const;

export const memberId = (userId: string, organizationId: string): string =>
  `mem_${userId}_${organizationId}`;

/**
 * Two organizations side by side plus a soft-deleted one.
 *
 * Every isolation assertion here is "the actor from A asks for the B-shaped
 * thing", so B is always populated: a test proving the listing returns A's
 * organization means nothing unless B's was sitting in the same table.
 */
export function seedWorld(): FakeWorld {
  const db = new FakeWorld();

  const organization = (id: string, name: string, slug: string, status = 'active'): void => {
    db.insert('organization', {
      id,
      name,
      slug,
      status,
      planId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
  };
  organization(IDS.orgA, 'Acme', 'acme');
  organization(IDS.orgB, 'Globex', 'globex');
  organization(IDS.orgDeleted, 'Initech', 'initech', 'deleted');

  for (const id of Object.values(IDS)) {
    if (id.startsWith('usr_')) {
      db.insert('user', {
        id,
        email: `${id}@example.com`,
        name: null,
        disabledAt: null,
      });
    }
  }

  const member = (organizationId: string, userId: string, role: string): void => {
    db.insert('organizationMember', {
      id: memberId(userId, organizationId),
      organizationId,
      userId,
      role,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  };
  member(IDS.orgA, IDS.ownerA, 'owner');
  member(IDS.orgA, IDS.adminA, 'admin');
  member(IDS.orgA, IDS.developerA, 'developer');
  member(IDS.orgA, IDS.viewerA, 'viewer');
  member(IDS.orgB, IDS.ownerB, 'owner');
  member(IDS.orgB, IDS.strangerB, 'developer');
  // The soft-deleted organization still has a live membership row: the listing
  // must drop it because the ORGANIZATION is deleted, not because the
  // membership is gone.
  member(IDS.orgDeleted, IDS.ownerA, 'owner');

  return db;
}

export function principalFor(userId: string): UserPrincipal {
  return {
    userId,
    email: `${userId}@example.com`,
    sessionId: `ses_${userId}`,
    ipAddress: '203.0.113.9',
    userAgent: 'jest',
  };
}

/**
 * A real `RequestContext`, built by the real `TenantResolver` against the fake.
 *
 * Hand-rolling one would let a service test pass with a context production
 * could never produce - a role that does not match the membership row, or an
 * organization the user is not in. Going through the resolver means every
 * context in these tests has been through the same membership check the guard
 * applies.
 */
export async function contextFor(
  db: FakeWorld,
  userId: string,
  organizationId: string,
): Promise<RequestContext> {
  const resolver = new TenantResolver(db.asPrisma());
  const request = {
    params: { orgId: organizationId },
    headers: { 'user-agent': 'jest' },
    ip: '203.0.113.9',
  } as unknown as TenantRequest;
  return resolver.resolve(
    { userId, email: `${userId}@example.com`, sessionId: `ses_${userId}` },
    request,
    { from: 'params' },
  );
}
