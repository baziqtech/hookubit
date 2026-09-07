import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CROSS_TENANT_MESSAGE, RequestContext, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import {
  AuditLogDto,
  AuditLogListDto,
  ListAuditLogsQueryDto,
  toAuditLogDto,
} from './dto';

/**
 * READ-ONLY access to `audit_logs`.
 *
 * ## Why there is no write path here
 *
 * Rows are written by `AuditService.recordFor`, from inside the transaction of
 * the operation they record, so the row commits or rolls back with the change
 * it describes. That is the whole guarantee. A create route on this module
 * would let a caller file a row for something that never happened; an update or
 * delete route would let one remove the record of something that did. Either
 * turns the table from evidence into a claim.
 *
 * So this class calls exactly three things on the scoped repository -
 * `findPage`, `findById` and nothing else - and there is a test that asserts the
 * controller exposes no verb but GET. **If something in the log is wrong, the
 * correction is a NEW row, written by whatever component noticed.**
 *
 * ## Why it never touches `PrismaService`
 *
 * Everything goes through `TenantScopeFactory`, so the organization predicate is
 * in the WHERE clause of every query rather than in a check after it. An audit
 * id from another tenant matches zero rows and answers the same 404 as an id
 * that never existed - it never reaches a "does this belong to me?" branch that
 * could be got wrong.
 *
 * ## Why it never widens redaction
 *
 * `metadata` is served exactly as `AuditService` stored it. Nothing here joins
 * back to the resource a row describes to "fill in" a value the writer replaced
 * with `[redacted]`, and there is no filter over metadata contents - see
 * `ListAuditLogsQueryDto` for why a metadata predicate would be an oracle
 * against the redaction.
 */
@Injectable()
export class AuditLogsService {
  constructor(private readonly scopes: TenantScopeFactory) {}

  /**
   * One page of the organization's audit trail, newest first.
   *
   * `findPage`, not `findMany`: a bounded read that returns a bare array cannot
   * tell its caller the bound was reached, and on this table that is the
   * difference between "nobody touched that endpoint" and "nobody touched it in
   * the fifty rows you happened to be shown". `has_more`/`next_offset` are what
   * make "I have seen the whole trail" expressible.
   *
   * Ordered by `created_at DESC`, which is the leading edge of both indexes on
   * the table. Rows written in the same millisecond have no defined order
   * between them, so a row can in principle move across an offset boundary -
   * the same caveat every offset-paged list in this API carries. An investigator
   * pinning an exact window should narrow with `created_after`/`created_before`
   * rather than paging deep.
   */
  async list(context: RequestContext, query: ListAuditLogsQueryDto): Promise<AuditLogListDto> {
    const page = await this.scopes.for(context).auditLogs.findPage({
      where: AuditLogsService.filter(query),
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });

    return {
      data: page.rows.map(toAuditLogDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * One row, for deep-linking out of the list.
   *
   * `findById` plus `CROSS_TENANT_MESSAGE` rather than `requireById`, matching
   * endpoints, api-keys and the policy modules: `ScopedRepository.notFound()`
   * still says `Audit log entry not found.`, and a distinct message for this
   * table would tell an outsider that the id they guessed names a real row in
   * somebody else's organization.
   */
  async get(context: RequestContext, auditLogId: string): Promise<AuditLogDto> {
    const row = await this.scopes.for(context).auditLogs.findById(auditLogId);
    if (!row) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
    return toAuditLogDto(row);
  }

  /**
   * The caller-supplied half of the WHERE. The tenant half is ANDed in by
   * `ScopedRepository` afterwards and is not expressible from here.
   *
   * Absent filters are omitted rather than written as `undefined`: Prisma treats
   * an explicit `undefined` as "no condition", but leaving the keys out keeps
   * the emitted SQL - and the query log a test asserts on - free of noise.
   */
  private static filter(query: ListAuditLogsQueryDto): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.user_id) where.userId = query.user_id;
    if (query.action) where.action = query.action;
    if (query.resource_type) where.resourceType = query.resource_type;
    if (query.resource_id) where.resourceId = query.resource_id;

    const after = AuditLogsService.instant(query.created_after, 'created_after');
    const before = AuditLogsService.instant(query.created_before, 'created_before');
    if (after && before && after.getTime() > before.getTime()) {
      // Refused rather than silently returning nothing: an empty page reads as
      // "nothing happened", which is the one answer an audit log must never give
      // by accident.
      throw new AppError(
        'invalid_request',
        '"created_after" is later than "created_before", so the range selects nothing.',
        { fields: ['created_after', 'created_before'] },
      );
    }
    if (after || before) {
      where.createdAt = {
        ...(after ? { gte: after } : {}),
        ...(before ? { lte: before } : {}),
      };
    }
    return where;
  }

  /**
   * Parsed rather than trusted.
   *
   * `@IsISO8601` on the DTO is only reached over HTTP. This service is a plain
   * class - a job, a CLI or a test can call `list` with whatever it likes - and
   * an `Invalid Date` reaching Prisma is a 500 rather than the 400 the caller
   * earned. The duplication is deliberate, for the same reason the subscriptions
   * module re-asserts its event-type rule below the DTO edge.
   */
  private static instant(value: string | undefined, field: string): Date | null {
    if (value === undefined) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError('invalid_request', `"${field}" must be an ISO-8601 timestamp.`, { field });
    }
    return parsed;
  }
}
