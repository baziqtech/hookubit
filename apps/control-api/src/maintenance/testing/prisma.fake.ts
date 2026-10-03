import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * The slice of PostgreSQL the auto-disable sweep touches, in memory.
 *
 * Hand-rolled rather than reusing `FakeTenantPrisma`: that fake models the
 * TENANT-SCOPED delegates the request path uses, and the whole point of this
 * sweep is that it has no tenant. What it needs instead is a relation filter
 * over `endpoint_health -> endpoints`, a nested `select` down to
 * `project.organization_id`, a conditional `updateMany` that really evaluates
 * its predicate, and an advisory lock that can be made to fail - none of which
 * that fake has, and three of which are the properties under test.
 *
 * Test files only; never imported by application code.
 */

export interface FakeEndpoint {
  id: string;
  name: string;
  url: string;
  projectId: string;
  status: string;
  enabled: boolean;
  disabledReason: string | null;
  disabledAt: Date | null;
}

export interface FakeHealth {
  endpointId: string;
  state: string;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  openedAt: Date | null;
}

export interface FakeAuditRow {
  id: string;
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
}

export class FakeMaintenancePrisma {
  readonly endpoints = new Map<string, FakeEndpoint>();
  readonly health = new Map<string, FakeHealth>();
  /** projectId -> organizationId. */
  readonly projects = new Map<string, string>();
  readonly auditRows: FakeAuditRow[] = [];

  /** Set false to model another replica already holding the advisory lock. */
  lockAvailable = true;
  /** Every advisory-lock acquisition attempted, so a test can prove it happened. */
  lockAttempts = 0;
  /** Transactions opened, so a test can prove the pass is one transaction. */
  transactions = 0;

  seedProject(projectId: string, organizationId: string): void {
    this.projects.set(projectId, organizationId);
  }

  seedEndpoint(endpoint: Partial<FakeEndpoint> & { id: string; projectId: string }): FakeEndpoint {
    const row: FakeEndpoint = {
      name: 'endpoint',
      url: 'https://example.test/hook',
      status: 'active',
      enabled: true,
      disabledReason: null,
      disabledAt: null,
      ...endpoint,
    };
    this.endpoints.set(row.id, row);
    return row;
  }

  seedHealth(health: Partial<FakeHealth> & { endpointId: string }): FakeHealth {
    const row: FakeHealth = {
      state: 'open',
      consecutiveFailures: 5,
      lastSuccessAt: null,
      openedAt: null,
      ...health,
    };
    this.health.set(row.endpointId, row);
    return row;
  }

  /** The shape the service is injected with. */
  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  async $transaction<T>(fn: (tx: FakeMaintenancePrisma) => Promise<T>): Promise<T> {
    this.transactions += 1;
    // No rollback: an in-memory map has no undo. Stated rather than pretended -
    // no test here leans on a failed pass leaving nothing behind.
    return fn(this);
  }

  /** Only ever called with the advisory-lock statement. */
  async $queryRaw<T>(): Promise<T> {
    this.lockAttempts += 1;
    return [{ locked: this.lockAvailable }] as unknown as T;
  }

  readonly endpointHealth = {
    findMany: async (args: {
      where: {
        state: string;
        openedAt: { lte: Date };
        endpoint: { status: string; enabled: boolean };
      };
      take: number;
    }): Promise<unknown[]> => {
      const matched = [...this.health.values()].filter((row) => {
        if (row.state !== args.where.state) return false;
        if (!row.openedAt || row.openedAt.getTime() > args.where.openedAt.lte.getTime()) {
          return false;
        }
        const endpoint = this.endpoints.get(row.endpointId);
        if (!endpoint) return false;
        return (
          endpoint.status === args.where.endpoint.status &&
          endpoint.enabled === args.where.endpoint.enabled
        );
      });
      matched.sort((a, b) => (a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0));
      return matched.slice(0, args.take).map((row) => {
        const endpoint = this.endpoints.get(row.endpointId) as FakeEndpoint;
        return {
          endpointId: row.endpointId,
          openedAt: row.openedAt,
          consecutiveFailures: row.consecutiveFailures,
          lastSuccessAt: row.lastSuccessAt,
          endpoint: {
            name: endpoint.name,
            url: endpoint.url,
            status: endpoint.status,
            projectId: endpoint.projectId,
            project: { organizationId: this.projects.get(endpoint.projectId) ?? 'org_unknown' },
          },
        };
      });
    },
  };

  readonly endpoint = {
    updateMany: async (args: {
      where: { id: string; status: string; enabled: boolean };
      data: Partial<FakeEndpoint>;
    }): Promise<{ count: number }> => {
      const row = this.endpoints.get(args.where.id);
      // The predicate is really evaluated. A fake that updated on id alone
      // would pass the concurrency test vacuously - and that predicate IS the
      // concurrency story.
      if (!row || row.status !== args.where.status || row.enabled !== args.where.enabled) {
        return { count: 0 };
      }
      this.endpoints.set(args.where.id, { ...row, ...args.data });
      return { count: 1 };
    },
  };

  readonly auditLog = {
    create: async (args: { data: FakeAuditRow }): Promise<{ id: string }> => {
      this.auditRows.push(args.data);
      return { id: args.data.id };
    },
  };
}
