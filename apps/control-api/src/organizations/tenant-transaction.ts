import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext, TenantScope, TenantScopeFactory } from '../authz';
// See the docblock below. The
// scoped repositories cannot open a transaction, and this is the only way to
// get one without every service holding the unscoped client. Allowlisted by
// exact filename in .eslintrc.json; the entry goes away when this moves into
// src/authz.
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * One database transaction, with a `TenantScope` bound to it.
 *
 * `TenantScope.withClient(...)` exists for exactly this and its docblock says
 * "use inside `$transaction`" — but nothing in the authorization layer can
 * START a transaction. `TenantScopeFactory` takes a client and does not expose
 * one, `ScopedRepository`'s transaction runner is private and wraps a single
 * read-after-write pair, and `PrismaService` is banned from module code by
 * eslint. A module that needed two statements to be atomic therefore had a
 * choice between injecting the unscoped client and not being atomic, and the
 * members module cannot take either:
 *
 *   assertRoleChangeAllowed's own docblock: "Count it inside the same
 *   transaction as the update, or two concurrent demotions each see two owners
 *   and leave zero."
 *
 * That is a real race with a permanent consequence — an organization with no
 * owner cannot be recovered through the API, because nobody left holds
 * `members.write` at owner rank.
 *
 * The scope handed to the callback is bound to the transaction client, so its
 * reads and writes are inside it AND still carry the tenant predicate. The raw
 * `tx` is handed over too, for `AuditService.recordFor`, which takes a client
 * so the audit row commits with the change it describes.
 *
 * PLACEMENT: belongs on `TenantScopeFactory` in `src/authz` as
 * `transaction(context, fn)` — see HANDOFF.md.
 */
@Injectable()
export class TenantTransactionRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: TenantScopeFactory,
  ) {}

  async run<T>(
    context: RequestContext,
    fn: (scope: TenantScope, tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) => fn(this.scopes.for(context, tx), tx));
  }
}
