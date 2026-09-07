import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogDto, AuditLogListDto, ListAuditLogsQueryDto } from './dto';

const MINUTE = 60_000;

/**
 * The audit trail, read-only.
 *
 * ## Two GETs and nothing else, on purpose
 *
 * There is no POST, PATCH, PUT or DELETE on this controller and there must
 * never be one. Rows are written by `AuditService.recordFor` from inside the
 * transaction of the operation they record; a write route here would let a
 * caller file a row for something that never happened, or erase the record of
 * something that did. A correction is a NEW row. `audit.no-mutations.spec.ts`
 * asserts the shape of this class rather than trusting the reading of it.
 *
 * ## Why `audit.read` and not `members.read`
 *
 * `audit.read` is owner/admin only, and it exists in the permission matrix for
 * exactly this table. These rows carry other members' actions, their IP
 * addresses and their user agents; `members.read` is held by viewer and billing
 * as well, so reusing it would hand two low-privilege roles a log of everyone
 * else's whereabouts. The 403 that a viewer gets here is the point.
 *
 * ## Throttled
 *
 * `user_id`, `resource_type` and `resource_id` are not indexed (see
 * `ListAuditLogsQueryDto`), so a filtered read is a scan over the tenant's
 * history on the largest table in the control plane. The limit is generous
 * enough for a human working an incident and low enough that a loop cannot use
 * this route as a way to make the database do unbounded work.
 */
@ApiTags('audit')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The organization or audit row does not exist, or belongs to another tenant. One answer ' +
    'with one message, on purpose: a 403 here would confirm that an id scraped from somewhere ' +
    'else names a real row in someone else’s organization.',
})
@ApiForbiddenResponse({
  description:
    'You are in this tenant but your role does not allow it. `audit.read` is owner/admin: ' +
    'these rows carry other members’ actions, IP addresses and user agents.',
})
@Controller('organizations/:orgId/audit-logs')
@UseGuards(ThrottleGuard)
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @Authorized('audit.read')
  @Throttle({ name: 'audit.list', limit: 120, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'List the organization’s audit trail',
    description:
      'Newest first, scoped to this organization by a predicate in the WHERE clause rather ' +
      'than a check after the read. Filters: `user_id`, `action`, `resource_type`, ' +
      '`resource_id` and the `created_after`/`created_before` range. `action` and the date ' +
      'range are index-supported; `user_id`, `resource_type` and `resource_id` are SCANS ' +
      'within the organization and date window - pair them with `created_after`. ' +
      'Paged with the canonical envelope `{ data, has_more, next_offset }`; `next_offset` is ' +
      'null - never absent, never 0 - on the last page. `metadata` is served exactly as it was ' +
      'stored: values redacted at write time stay redacted, and there is no filter over ' +
      'metadata contents, because one would be an oracle against that redaction.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiOkResponse({ type: AuditLogListDto })
  list(
    @Tenant() context: RequestContext,
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<AuditLogListDto> {
    return this.auditLogs.list(context, query);
  }

  @Get(':auditLogId')
  @Authorized('audit.read')
  @Throttle({ name: 'audit.get', limit: 300, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Fetch one audit row',
    description:
      'For deep-linking out of the list. Read-only, like everything on this controller: an ' +
      'audit row is never edited or removed, and a correction is a new row.',
  })
  @ApiParam({ name: 'orgId', example: 'org_01J...' })
  @ApiParam({ name: 'auditLogId', example: 'aud_01J...' })
  @ApiOkResponse({ type: AuditLogDto })
  get(
    @Tenant() context: RequestContext,
    @Param('auditLogId') auditLogId: string,
  ): Promise<AuditLogDto> {
    return this.auditLogs.get(context, auditLogId);
  }
}
