import { Injectable } from '@nestjs/common';
// See the docblock below.
// `users` is not a tenant-owned table, so `TenantScope` has no repository for
// it and there is nothing safer to inject. Allowlisted by exact filename in
// .eslintrc.json; the entry goes away when this moves into src/authz.
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * Identity lookups for tables the tenant scope structurally cannot cover.
 *
 * `TenantScopeFactory`'s docblock is explicit that `users` is deliberately NOT
 * one of its repositories: it is not tenant-owned, and inventing a tenant scope
 * for it would be worse than leaving it out. But a members list has to show who
 * the members ARE — an id and a role is not an answer to "who is in my
 * organization" — and an invitation has to be addressed to a person.
 *
 * So this is the narrow, named alternative to a service reaching for the
 * unscoped client. Two rules, both load-bearing:
 *
 *  1. **`byIds` is only ever given ids that came out of a tenant-scoped
 *     query.** `organization_members.user_id` rows returned by
 *     `scope.members.findMany()` are already proven to be inside the caller's
 *     organization; resolving those ids to names leaks nothing the caller was
 *     not already entitled to. Passing it ids from a request body would be an
 *     enumeration oracle over the whole user table — do not.
 *  2. **`findByEmail` result must never reach the client.** It exists so an
 *     invitation can be addressed and so a duplicate invite can be handled
 *     silently. Every caller must produce the SAME response whether it returns
 *     a row or null; see `MembersService.invite`.
 *
 * Only non-sensitive columns are selected. `password_hash` is not reachable
 * through this type, so a careless spread into a response body or an audit
 * payload cannot leak it.
 *
 * PLACEMENT: belongs in `src/authz` beside `UserScope` — see HANDOFF.md.
 */
export interface UserIdentity {
  id: string;
  email: string;
  name: string | null;
  disabledAt: Date | null;
}

const IDENTITY_COLUMNS = {
  id: true,
  email: true,
  name: true,
  disabledAt: true,
} as const;

@Injectable()
export class UserDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve ids that are ALREADY proven to be inside the caller's tenant.
   * Returns a map so a caller cannot silently mis-pair rows by index.
   */
  async byIds(ids: readonly string[]): Promise<Map<string, UserIdentity>> {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && id.length > 0);
    if (unique.length === 0) return new Map();

    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: IDENTITY_COLUMNS,
    });
    return new Map(users.map((user) => [user.id, user]));
  }

  /**
   * For addressing an invitation. The caller MUST answer identically whether
   * this returns a row or null — that is the whole enumeration-resistance
   * posture of the auth module, and an invite endpoint that 409s on a known
   * address would undo it.
   */
  async findByEmail(email: string): Promise<UserIdentity | null> {
    return this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: IDENTITY_COLUMNS,
    });
  }
}
