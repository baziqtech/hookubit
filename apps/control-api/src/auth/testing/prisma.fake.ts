import {
  Organization,
  OrganizationMember,
  Session,
  User,
  UserToken,
  UserTokenType,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Minimal in-memory stand-in for the tables auth touches.
 *
 * It is deliberately not a general Prisma mock: it reproduces the two
 * behaviours the auth logic actually relies on - unique constraints on
 * `users.email` / `user_tokens.token_hash`, and the conditional UPDATE that
 * makes token consumption single-use. Test file only; never imported by
 * application code.
 */
export class FakePrisma {
  readonly users = new Map<string, User>();
  readonly userTokens = new Map<string, UserToken>();
  readonly organizations = new Map<string, Organization>();
  readonly sessions = new Map<string, Session>();
  readonly members = new Map<string, OrganizationMember>();
  readonly auditLogs: Array<Record<string, unknown>> = [];

  /**
   * Shaped like a real Prisma P2002, `meta.target` included. The target is the
   * whole point: `register` writes two unique columns and has to tell
   * `users.email` (terminal) from `organizations.slug` (retryable). A fake that
   * omitted it would let the old, wrong branch pass.
   */
  private static uniqueViolation(target: string): Error {
    const err = new Error(`Unique constraint failed on ${target}`) as Error & {
      code: string;
      meta: { target: string[] };
    };
    err.code = 'P2002';
    err.meta = { target: [target.split('.').pop() ?? target] };
    return err;
  }

  readonly user = {
    count: async (): Promise<number> => this.users.size,
    findUnique: async (args: { where: { id?: string; email?: string } }): Promise<User | null> => {
      const { id, email } = args.where;
      for (const user of this.users.values()) {
        if (id && user.id === id) return { ...user };
        if (email && user.email === email) return { ...user };
      }
      return null;
    },
    create: async (args: { data: Partial<User> & { id: string; email: string } }): Promise<User> => {
      for (const existing of this.users.values()) {
        if (existing.email === args.data.email) throw FakePrisma.uniqueViolation('users.email');
      }
      const user: User = {
        id: args.data.id,
        email: args.data.email,
        name: args.data.name ?? null,
        passwordHash: args.data.passwordHash ?? '',
        emailVerifiedAt: args.data.emailVerifiedAt ?? null,
        lastLoginAt: null,
        disabledAt: null,
        onboardingCompletedAt: args.data.onboardingCompletedAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.users.set(user.id, user);
      return { ...user };
    },
    update: async (args: { where: { id: string }; data: Partial<User> }): Promise<User> => {
      const user = this.users.get(args.where.id);
      if (!user) throw new Error('Record to update not found');
      const updated: User = { ...user, ...args.data, updatedAt: new Date() };
      this.users.set(updated.id, updated);
      return { ...updated };
    },
    /**
     * Mirrors the conditional UPDATE onboarding completion relies on:
     * `... WHERE id = $1 AND onboarding_completed_at IS NULL AND disabled_at IS
     * NULL`. The NULL predicates are the whole point - they are what makes a
     * second completion touch zero rows instead of moving the timestamp
     * forward - so a fake that ignored the WHERE would let a broken
     * read-then-write pass.
     */
    updateMany: async (args: {
      where: { id?: string; onboardingCompletedAt?: null; disabledAt?: null };
      data: Partial<User>;
    }): Promise<{ count: number }> => {
      const { where, data } = args;
      let count = 0;
      for (const [id, user] of this.users) {
        if (where.id !== undefined && user.id !== where.id) continue;
        if (where.onboardingCompletedAt === null && user.onboardingCompletedAt !== null) continue;
        if (where.disabledAt === null && user.disabledAt !== null) continue;
        this.users.set(id, { ...user, ...data, updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
  };

  readonly userToken = {
    create: async (args: {
      data: Partial<UserToken> & {
        id: string;
        email: string;
        type: UserTokenType;
        tokenHash: string;
        expiresAt: Date;
      };
    }): Promise<UserToken> => {
      for (const existing of this.userTokens.values()) {
        if (existing.tokenHash === args.data.tokenHash) {
          throw FakePrisma.uniqueViolation('user_tokens.token_hash');
        }
      }
      const token: UserToken = {
        id: args.data.id,
        userId: args.data.userId ?? null,
        email: args.data.email,
        type: args.data.type,
        tokenHash: args.data.tokenHash,
        metadata: args.data.metadata ?? null,
        expiresAt: args.data.expiresAt,
        consumedAt: args.data.consumedAt ?? null,
        createdAt: new Date(),
      };
      this.userTokens.set(token.id, token);
      return { ...token };
    },
    findUnique: async (args: { where: { tokenHash: string } }): Promise<UserToken | null> => {
      for (const token of this.userTokens.values()) {
        if (token.tokenHash === args.where.tokenHash) return { ...token };
      }
      return null;
    },
    /** Mirrors the conditional UPDATE ... WHERE consumed_at IS NULL AND expires_at > now(). */
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
      for (const [id, token] of this.userTokens) {
        if (where.tokenHash !== undefined && token.tokenHash !== where.tokenHash) continue;
        if (where.email !== undefined && token.email !== where.email) continue;
        if (where.type !== undefined && token.type !== where.type) continue;
        if (where.consumedAt === null && token.consumedAt !== null) continue;
        if (where.expiresAt && token.expiresAt.getTime() <= where.expiresAt.gt.getTime()) continue;
        this.userTokens.set(id, { ...token, consumedAt: data.consumedAt });
        count += 1;
      }
      return { count };
    },
  };

  readonly session = {
    create: async (args: {
      data: {
        id: string;
        userId: string;
        expiresAt: Date;
        ipAddress?: string | null;
        userAgent?: string | null;
      };
    }): Promise<Session> => {
      const session: Session = {
        id: args.data.id,
        userId: args.data.userId,
        ipAddress: args.data.ipAddress ?? null,
        userAgent: args.data.userAgent ?? null,
        lastSeenAt: null,
        expiresAt: args.data.expiresAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: new Date(),
      };
      this.sessions.set(session.id, session);
      return { ...session };
    },
    /**
     * Supports `include: { user: ... }`, which SessionService.verify relies on
     * to reject sessions belonging to a disabled or deleted account (FIX 4).
     */
    findUnique: async (args: {
      where: { id: string };
      include?: { user?: unknown };
    }): Promise<(Session & { user?: User | null }) | null> => {
      const found = this.sessions.get(args.where.id);
      if (!found) return null;
      if (!args.include?.user) return { ...found };
      const user = this.users.get(found.userId);
      return { ...found, user: user ? { ...user } : null };
    },
    /** Mirrors UPDATE ... WHERE revoked_at IS NULL - revocation is idempotent. */
    updateMany: async (args: {
      where: { id?: string; userId?: string; revokedAt?: null };
      data: { revokedAt: Date; revokedReason?: string | null };
    }): Promise<{ count: number }> => {
      const { where, data } = args;
      let count = 0;
      for (const [id, session] of this.sessions) {
        if (where.id !== undefined && session.id !== where.id) continue;
        if (where.userId !== undefined && session.userId !== where.userId) continue;
        if (where.revokedAt === null && session.revokedAt !== null) continue;
        this.sessions.set(id, {
          ...session,
          revokedAt: data.revokedAt,
          revokedReason: data.revokedReason ?? null,
        });
        count += 1;
      }
      return { count };
    },
  };

  readonly organization = {
    findUnique: async (args: { where: { slug: string } }): Promise<Organization | null> => {
      for (const org of this.organizations.values()) {
        if (org.slug === args.where.slug) return { ...org };
      }
      return null;
    },
    create: async (args: {
      data: { id: string; name: string; slug: string };
    }): Promise<Organization> => {
      for (const org of this.organizations.values()) {
        if (org.slug === args.data.slug) throw FakePrisma.uniqueViolation('organizations.slug');
      }
      const org = {
        id: args.data.id,
        name: args.data.name,
        slug: args.data.slug,
        status: 'active',
        planId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Organization;
      this.organizations.set(org.id, org);
      return { ...org };
    },
  };

  readonly organizationMember = {
    findFirst: async (args: {
      where: { userId: string };
    }): Promise<OrganizationMember | null> => {
      for (const member of this.members.values()) {
        if (member.userId === args.where.userId) return { ...member };
      }
      return null;
    },
    create: async (args: {
      data: { id: string; organizationId: string; userId: string; role: string };
    }): Promise<OrganizationMember> => {
      const member = {
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as OrganizationMember;
      this.members.set(member.id, member);
      return { ...member };
    },
  };

  readonly auditLog = {
    create: async (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => {
      this.auditLogs.push(args.data);
      return args.data;
    },
  };

  /** Every `$executeRaw` issued, in order. Lets tests assert the advisory lock. */
  readonly rawStatements: string[] = [];

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    this.rawStatements.push(
      strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), ''),
    );
    return 0;
  }

  /**
   * Rolls back on failure, because the code under test now depends on it: a
   * registration that loses the `organizations.slug` race is retried, and the
   * retry can only succeed if the losing attempt's writes were undone. Shallow
   * copies of each map are enough - rows are replaced, never mutated in place.
   */
  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    const snapshot = {
      users: new Map(this.users),
      userTokens: new Map(this.userTokens),
      organizations: new Map(this.organizations),
      sessions: new Map(this.sessions),
      members: new Map(this.members),
      auditLogs: this.auditLogs.length,
    };
    try {
      return await fn(this);
    } catch (err) {
      FakePrisma.restore(this.users, snapshot.users);
      FakePrisma.restore(this.userTokens, snapshot.userTokens);
      FakePrisma.restore(this.organizations, snapshot.organizations);
      FakePrisma.restore(this.sessions, snapshot.sessions);
      FakePrisma.restore(this.members, snapshot.members);
      this.auditLogs.length = snapshot.auditLogs;
      throw err;
    }
  }

  private static restore<K, V>(live: Map<K, V>, snapshot: Map<K, V>): void {
    live.clear();
    for (const [key, value] of snapshot) live.set(key, value);
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}
