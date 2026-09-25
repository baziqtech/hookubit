import { Controller, Get, UseGuards } from '@nestjs/common';
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
import { BillingService } from './billing.service';
import { BillingDto } from './dto';

const MINUTE = 60_000;

/**
 * What this organization is using, and what it is on.
 *
 * `billing.read` is owner, admin and the `billing` role — NOT developer or
 * viewer. What an organization is charged is commercial information about the
 * organization, and the permission matrix has always drawn that line; this
 * route is the first thing to sit behind it.
 */
@ApiTags('billing')
@ApiCookieAuth('session')
@ApiNotFoundResponse({ description: 'No such organization, or not yours.' })
@ApiForbiddenResponse({
  description: 'Owner, admin and billing only. Developers and viewers cannot see this.',
})
@ApiParam({ name: 'orgId', type: String, example: 'org_01J8ZK...' })
@Controller('organizations/:orgId/billing')
@UseGuards(ThrottleGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @Authorized('billing.read')
  @Throttle({ name: 'billing.read', limit: 60, windowMs: 5 * MINUTE })
  @ApiOperation({
    summary: 'Metered volume for the calendar month to date',
    description:
      'Read from the HOURLY ROLLUPS in `usage_records`, not by counting `events` and ' +
      '`deliveries` — a month of those is a sequential scan of the two largest tables in the ' +
      'system, and this page would run it on every open. `period_end` is therefore the last ' +
      'COMPLETE hour, not now.\n\n' +
      '`billable` is false everywhere: there is no payment provider, no invoice and no price ' +
      'in this system. The response says so rather than returning a total of zero that somebody ' +
      'would believe.',
  })
  @ApiOkResponse({ type: BillingDto })
  summary(@Tenant() context: RequestContext): Promise<BillingDto> {
    return this.billing.summary(context);
  }
}
