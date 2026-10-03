import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationDestination, NotificationStatus, Prisma } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';
import { AuditService, RequestContext, TenantScope, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { parseMailbox } from '../notifications';
import {
  CreateDestinationDto,
  DestinationDto,
  DestinationListDto,
  UpdateDestinationDto,
  toDestinationDto,
} from './dto';
import { isNotificationEvent, NOTIFICATION_EVENT_NAMES } from './notification-rules';
import { OPERATIONAL_MAILER, OperationalMailer } from './operational-mailer.port';

/** A confirmation link is good for seven days, as the design states on screen. */
export const CONFIRMATION_TTL_MS = 7 * 24 * 3_600_000;

/** How many destinations one project may hold. */
export const MAX_DESTINATIONS_PER_PROJECT = 20;

/**
 * Where a project sends operational alerts, and who has agreed to receive them.
 *
 * ## Confirmation is not a formality
 *
 * A destination receives NOTHING until somebody who can read the address has
 * clicked the link. A group address exists precisely so one person can put a
 * whole team on it, and without this step adding `oncall@` to a project would
 * be a way to mail people indefinitely with none of them having agreed. It is
 * also the only check available that the address is real: a typo'd address
 * that is never confirmed sits visibly in the list as `pending` rather than
 * silently swallowing every alert the project ever raises.
 *
 * ## Email only, for now
 *
 * The model carries a `slack` kind because the destination table should not
 * have to change when it arrives, and the route refuses it with a reason. A
 * Slack destination needs an app, an OAuth install per workspace and a story
 * for the app being removed; pretending otherwise by accepting the value would
 * create rows nothing can ever deliver to.
 */
@Injectable()
export class NotificationDestinationsService {
  private readonly logger = new Logger(NotificationDestinationsService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
    @Inject(OPERATIONAL_MAILER) private readonly mailer: OperationalMailer,
  ) {}

  async list(context: RequestContext): Promise<DestinationListDto> {
    const page = await this.scopes.for(context).notificationDestinations.findPage({
      orderBy: { createdAt: 'asc' },
      take: MAX_DESTINATIONS_PER_PROJECT,
    });
    return {
      data: page.rows.map(toDestinationDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * Create a destination and send its confirmation.
   *
   * The row is written BEFORE the mail is sent, and a send failure does not
   * roll it back. A destination that exists and is unconfirmed is a visible,
   * recoverable state with a Resend button; a destination that was refused
   * because the mail server was briefly unhappy is a form the operator has to
   * fill in again and, more likely, a feature they give up on.
   */
  async create(context: RequestContext, dto: CreateDestinationDto): Promise<DestinationDto> {
    if (dto.kind !== 'email') {
      throw new AppError(
        'invalid_request',
        "Only 'email' destinations can be created today. A Slack destination needs an app " +
          'installed in your workspace, which is not built yet — accepting it here would create ' +
          'a row nothing can deliver to.',
      );
    }

    const mailbox = parseMailbox(dto.target);
    if (!mailbox) {
      throw new AppError('invalid_request', `'${dto.target}' is not a valid email address.`);
    }
    const target = mailbox.address.toLowerCase();

    const scope = this.scopes.for(context);
    await this.assertRoom(scope);

    const events = NotificationDestinationsService.validateEvents(dto.events);
    const { raw, hash } = confirmationToken();

    let created: NotificationDestination;
    try {
      created = await scope.notificationDestinations.create({
        id: newId('notificationDestination'),
        kind: 'email',
        target,
        label: dto.label?.trim() || target,
        status: NotificationStatus.pending,
        events,
        confirmationTokenHash: hash,
        confirmationExpiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
      });
    } catch (err) {
      throw NotificationDestinationsService.translateDuplicate(err, target);
    }

    await this.audit.recordFor(context, {
      action: 'notification_destination.created',
      resourceType: 'notification_destination',
      resourceId: created.id,
      // The address is on the row. What the audit entry adds is WHO added it.
      metadata: { kind: created.kind, events: created.events },
    });

    await this.sendConfirmation(context, created, raw);
    return toDestinationDto(created);
  }

  async update(
    context: RequestContext,
    destinationId: string,
    dto: UpdateDestinationDto,
  ): Promise<DestinationDto> {
    const scope = this.scopes.for(context);
    const data: Prisma.NotificationDestinationUncheckedUpdateManyInput = {};

    if (dto.label !== undefined) data.label = dto.label.trim();
    if (dto.events !== undefined) {
      // An EMPTY list is legal and deliberate: it is how a destination is muted
      // without deleting it and losing its confirmation.
      data.events = NotificationDestinationsService.validateEvents(dto.events);
    }
    if (Object.keys(data).length === 0) {
      throw new AppError('invalid_request', 'Supply at least one of "label" or "events".');
    }

    const updated = await scope.notificationDestinations.updateById(destinationId, data);
    await this.audit.recordFor(context, {
      action: 'notification_destination.updated',
      resourceType: 'notification_destination',
      resourceId: destinationId,
      metadata: { events: updated.events },
    });
    return toDestinationDto(updated);
  }

  async remove(context: RequestContext, destinationId: string): Promise<void> {
    const scope = this.scopes.for(context);
    await scope.notificationDestinations.requireById(destinationId);
    await scope.notificationDestinations.deleteById(destinationId);
    await this.audit.recordFor(context, {
      action: 'notification_destination.deleted',
      resourceType: 'notification_destination',
      resourceId: destinationId,
    });
  }

  /**
   * Re-send the confirmation, with a NEW token.
   *
   * New rather than re-sent, because the old link may be sitting in a mailbox
   * somebody no longer has access to — which is very often exactly why the
   * resend is being asked for.
   */
  async resend(context: RequestContext, destinationId: string): Promise<DestinationDto> {
    const scope = this.scopes.for(context);
    const destination = await scope.notificationDestinations.requireById(destinationId);

    if (destination.status === NotificationStatus.confirmed) {
      throw new AppError(
        'conflict',
        'This address is already confirmed. Nothing to send.',
      );
    }

    const { raw, hash } = confirmationToken();
    const updated = await scope.notificationDestinations.updateById(destinationId, {
      confirmationTokenHash: hash,
      confirmationExpiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    });

    await this.sendConfirmation(context, updated, raw);
    return toDestinationDto(updated);
  }

  /**
   * Send a test alert to one destination.
   *
   * It goes through the SAME template as a real alert but is not recorded as a
   * dispatch, so it neither satisfies nor triggers the grouping rule. Sending
   * a test must not make the next real alert about the same thing disappear.
   */
  async test(context: RequestContext, destinationId: string): Promise<void> {
    const scope = this.scopes.for(context);
    const destination = await scope.notificationDestinations.requireById(destinationId);

    if (destination.status !== NotificationStatus.confirmed) {
      throw new AppError(
        'conflict',
        'This address has not been confirmed yet, so nothing can be sent to it. Confirm it from the link we emailed, or ask for a new one.',
      );
    }

    const project = context.requireProject();
    await this.mailer.sendNotificationAlert(destination.target, {
      projectName: project.name,
      headline: 'Test alert',
      body: 'This is a test. Nothing is wrong. It went through exactly the same path a real alert takes, so if this arrived, alerts for this project will arrive.',
      link: `${project.id}`,
      occurrences: 1,
    });

    await scope.notificationDestinations.updateById(destinationId, { lastSentAt: new Date() });
  }

  // -------------------------------------------------------------------------

  private async sendConfirmation(
    context: RequestContext,
    destination: NotificationDestination,
    rawToken: string,
  ): Promise<void> {
    try {
      await this.mailer.sendNotificationConfirmation(destination.target, {
        projectName: context.requireProject().name,
        rawToken,
      });
    } catch (err) {
      // Recorded, not raised. The row exists and the UI shows it as pending
      // with a Resend button, which is a better place to be than a form the
      // operator has to fill in again.
      this.logger.error(
        `Could not send the confirmation for ${destination.id}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      await this.scopes
        .for(context)
        .notificationDestinations.updateById(destination.id, {
          lastError: 'The confirmation message could not be sent. Try resending it.',
        })
        .catch(() => undefined);
    }
  }

  private async assertRoom(scope: TenantScope): Promise<void> {
    const current = await scope.notificationDestinations.count();
    if (current < MAX_DESTINATIONS_PER_PROJECT) return;
    throw new AppError(
      'limit_exceeded',
      `This project already has ${current} notification destinations, which is the maximum.`,
      { limit: MAX_DESTINATIONS_PER_PROJECT, current, resource: 'notification_destination' },
    );
  }


  private static validateEvents(events: string[] | undefined): string[] {
    if (events === undefined) return [...NOTIFICATION_EVENT_NAMES];
    const seen = new Set<string>();
    for (const event of events) {
      if (!isNotificationEvent(event)) {
        throw new AppError(
          'invalid_request',
          `'${event}' is not a notification event. Valid values: ${NOTIFICATION_EVENT_NAMES.join(', ')}.`,
        );
      }
      seen.add(event);
    }
    return [...seen];
  }

  private static translateDuplicate(err: unknown, target: string): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new AppError(
        'conflict',
        `${target} is already a destination for this project. One address cannot be added twice — it would receive everything twice.`,
      );
    }
    return err;
  }

}

function confirmationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
