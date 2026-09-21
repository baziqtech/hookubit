import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Authorized, RequestContext, Tenant } from '../authz';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  ConfirmDestinationDto,
  ConfirmedDestinationDto,
  CreateDestinationDto,
  DestinationDto,
  DestinationListDto,
  UpdateDestinationDto,
} from './dto';
import { NotificationConfirmationService } from './notification-confirmation.service';
import { NotificationDestinationsService } from './notification-destinations.service';

const MINUTE = 60_000;

/**
 * Where a project sends operational alerts.
 *
 * Every write here causes MAIL to an address the caller chose, which is why
 * they are throttled harder than an ordinary write: a loop on `create` is a
 * way to send somebody a lot of confirmation messages using our reputation.
 */
@ApiTags('notifications')
@ApiCookieAuth('session')
@ApiNotFoundResponse({
  description:
    'The project or the destination does not exist or belongs to another tenant. One answer, ' +
    'one message.',
})
@ApiForbiddenResponse({ description: 'You are in this tenant but your role does not allow it.' })
@ApiParam({ name: 'projectId', type: String, example: 'proj_01J8ZK...' })
@Controller('projects/:projectId/notification-destinations')
@UseGuards(ThrottleGuard)
export class NotificationDestinationsController {
  constructor(private readonly destinations: NotificationDestinationsService) {}

  @Get()
  @Authorized('notifications.read')
  @ApiOperation({
    summary: 'Where this project sends alerts',
    description:
      'Readable by everyone who can read the delivery record: "who gets told when this breaks?" ' +
      'is part of understanding what happened.',
  })
  @ApiOkResponse({ type: DestinationListDto })
  list(@Tenant() context: RequestContext): Promise<DestinationListDto> {
    return this.destinations.list(context);
  }

  @Post()
  @Authorized('notifications.write')
  @Throttle({ name: 'notifications.create', limit: 10, windowMs: 10 * MINUTE })
  @ApiOperation({
    summary: 'Add a destination and send its confirmation',
    description:
      'The destination is created `pending` and receives NOTHING until somebody who can read ' +
      'the address clicks the link. The row is written before the message is sent and a send ' +
      'failure does not roll it back: a pending destination with a Resend button is a better ' +
      'place to be than a form you have to fill in again.',
  })
  @ApiOkResponse({ type: DestinationDto })
  @ApiConflictResponse({
    description:
      'This address is already a destination for this project, or the project is at its ceiling.',
  })
  create(
    @Tenant() context: RequestContext,
    @Body() dto: CreateDestinationDto,
  ): Promise<DestinationDto> {
    return this.destinations.create(context, dto);
  }

  @Patch(':destinationId')
  @Authorized('notifications.write')
  @ApiOperation({
    summary: 'Rename a destination, or change what it receives',
    description:
      '`events` REPLACES the list. An empty array mutes the destination without deleting it, ' +
      'which keeps its confirmation.',
  })
  @ApiOkResponse({ type: DestinationDto })
  update(
    @Tenant() context: RequestContext,
    @Param('destinationId') destinationId: string,
    @Body() dto: UpdateDestinationDto,
  ): Promise<DestinationDto> {
    return this.destinations.update(context, destinationId, dto);
  }

  @Delete(':destinationId')
  @Authorized('notifications.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a destination' })
  @ApiNoContentResponse()
  remove(
    @Tenant() context: RequestContext,
    @Param('destinationId') destinationId: string,
  ): Promise<void> {
    return this.destinations.remove(context, destinationId);
  }

  @Post(':destinationId/resend')
  @Authorized('notifications.write')
  @Throttle({ name: 'notifications.resend', limit: 5, windowMs: 10 * MINUTE })
  @ApiOperation({
    summary: 'Send the confirmation again, with a NEW token',
    description:
      'New rather than re-sent: the old link may be sitting in a mailbox somebody no longer has ' +
      'access to, which is very often exactly why a resend is being asked for.',
  })
  @ApiOkResponse({ type: DestinationDto })
  @ApiConflictResponse({ description: 'Already confirmed; there is nothing to send.' })
  resend(
    @Tenant() context: RequestContext,
    @Param('destinationId') destinationId: string,
  ): Promise<DestinationDto> {
    return this.destinations.resend(context, destinationId);
  }

  @Post(':destinationId/test')
  @Authorized('notifications.write')
  @Throttle({ name: 'notifications.test', limit: 5, windowMs: 10 * MINUTE })
  @ApiOperation({
    summary: 'Send a test alert',
    description:
      'Goes through the same template and the same transport a real alert takes, so an arrival ' +
      'proves the path. It is NOT recorded as a dispatch, so it neither satisfies nor triggers ' +
      'the grouping rule — sending a test must not make the next real alert disappear.',
  })
  @ApiNoContentResponse()
  @HttpCode(HttpStatus.NO_CONTENT)
  test(
    @Tenant() context: RequestContext,
    @Param('destinationId') destinationId: string,
  ): Promise<void> {
    return this.destinations.test(context, destinationId);
  }
}

/**
 * Redeeming a confirmation link.
 *
 * UNAUTHENTICATED and outside the project path, both deliberately. The person
 * who can read a group address is very often not a member of the organization
 * that added it — that is the point of using one — and putting this under
 * `/projects/:projectId` would also hand an unauthenticated caller a project id
 * to guess at. Possession of the token is the whole authority.
 */
@ApiTags('notifications')
@Controller('notification-destinations')
@UseGuards(ThrottleGuard)
export class NotificationConfirmationController {
  constructor(private readonly confirmations: NotificationConfirmationService) {}

  @Post('confirm')
  // No  — that decorator is what mounts SessionGuard, so its
  // absence is what makes this route public. Deliberate: see the class
  // docblock.
  // Tight: this is an unauthenticated endpoint that takes a guessable-shaped
  // secret, so the budget is what makes guessing pointless rather than merely
  // expensive.
  @Throttle({ name: 'notifications.confirm', limit: 10, windowMs: 10 * MINUTE })
  @ApiOperation({
    summary: 'Confirm an address for alerts',
    description:
      'Single use. "No such token", "already used" and "expired" all answer the same 404 with ' +
      'the same message: this endpoint is reachable by anyone, so distinguishing them is an ' +
      'oracle for which tokens exist — and all three are fixed the same way.',
  })
  @ApiOkResponse({ type: ConfirmedDestinationDto })
  confirm(@Body() dto: ConfirmDestinationDto): Promise<ConfirmedDestinationDto> {
    return this.confirmations.confirm(dto.token);
  }
}
