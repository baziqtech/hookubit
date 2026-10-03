import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { newId } from '../common/ids';
// The unscoped client, deliberately: this runs from a background sweep with no
// request and therefore no tenant context. `src/maintenance/**` is allowlisted
// in .eslintrc.json for exactly this reason.
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import {
  NOTIFICATION_EVENTS,
  shouldSend,
  type NotificationEvent,
} from '../notification-destinations/notification-rules';
import {
  OPERATIONAL_MAILER,
  OperationalMailer,
} from '../notification-destinations/operational-mailer.port';

export interface AlertInput {
  projectId: string;
  event: NotificationEvent;
  /**
   * The DEDUPLICATION key. It names the thing that happened, not the message:
   * `endpoint:ep_123:stopped`. Two endpoints failing are two subjects and
   * therefore two messages; one endpoint failing twice is one subject and
   * therefore one.
   */
  subject: string;
  /** One line. What happened. */
  headline: string;
  /** Two or three sentences. What it means and what to do about it. */
  body: string;
  /** Where in the dashboard to go and look. */
  link: string;
}

/** What one alert did, so a caller — and a test — can see it. */
export interface AlertReport {
  considered: number;
  sent: number;
  grouped: number;
  held: number;
  failed: number;
}

/**
 * Turning something that happened into messages, or deliberately into none.
 *
 * ## Why this is a sweep-side service and not part of the CRUD module
 *
 * It has no request and no tenant context — it is called from whatever noticed
 * the problem, which is background work. `NotificationDestinationsService`
 * manages destinations on behalf of a signed-in operator; this one sends to
 * them on behalf of nobody.
 *
 * ## Why a failure here is swallowed
 *
 * Every caller is doing something more important than telling someone about it:
 * the auto-disable sweep is stopping a dead endpoint accruing rows. An alert
 * that cannot be sent must never fail the thing it was about — that would mean
 * an SMTP outage stops endpoints being disabled, which is the tail wagging the
 * dog. Failures are recorded on the destination (`last_error`, visible in the
 * UI) and counted in the report.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPERATIONAL_MAILER) private readonly mailer: OperationalMailer,
  ) {}

  async alert(input: AlertInput, now: Date = new Date()): Promise<AlertReport> {
    const report: AlertReport = { considered: 0, sent: 0, grouped: 0, held: 0, failed: 0 };

    const destinations = await this.prisma.notificationDestination.findMany({
      where: {
        projectId: input.projectId,
        status: NotificationStatus.confirmed,
        events: { has: input.event },
      },
      include: {
        project: { select: { name: true } },
        // The one dispatch that could group with this. The unique index on
        // (destination_id, subject) makes it at most one row.
        notifications: { where: { subject: input.subject }, take: 1 },
      },
    });

    for (const destination of destinations) {
      report.considered += 1;
      const previous = destination.notifications[0] ?? null;

      const verdict = shouldSend(
        destination,
        input.event,
        input.subject,
        previous
          ? { subject: previous.subject, lastAt: previous.lastAt, sentAt: previous.sentAt }
          : null,
        now,
      );

      // The occurrence is recorded WHETHER OR NOT the message goes out. That is
      // what makes "this has happened 4 times in the last half hour" true in
      // the message that eventually does, and what stops a held alert being
      // forgotten entirely.
      const dispatch = await this.record(destination.id, input, now, previous !== null);

      if (!verdict.send) {
        if (verdict.reason === 'grouped') report.grouped += 1;
        else if (verdict.reason === 'quiet-hours') report.held += 1;
        continue;
      }

      try {
        await this.mailer.sendNotificationAlert(destination.target, {
          projectName: destination.project.name,
          headline: input.headline,
          body: input.body,
          link: input.link,
          occurrences: dispatch.occurrences,
        });
        await this.prisma.$transaction([
          this.prisma.notificationDispatch.update({
            where: { id: dispatch.id },
            // The occurrence counter resets on a successful send, so the NEXT
            // message counts from zero rather than from the beginning of time.
            data: { sentAt: now, occurrences: 1, firstAt: now },
          }),
          this.prisma.notificationDestination.update({
            where: { id: destination.id },
            data: { lastSentAt: now, lastError: null },
          }),
        ]);
        report.sent += 1;
      } catch (err) {
        report.failed += 1;
        const message = err instanceof Error ? err.message : 'unknown error';
        this.logger.error(`Alert to ${destination.id} failed: ${message}`);
        await this.prisma.notificationDestination
          .update({
            where: { id: destination.id },
            data: { lastError: `The last alert could not be delivered: ${message}` },
          })
          .catch(() => undefined);
      }
    }

    if (report.considered > 0) {
      this.logger.log(
        `${NOTIFICATION_EVENTS[input.event].label}: ${report.sent} sent, ${report.grouped} grouped, ${report.held} held, ${report.failed} failed.`,
      );
    }
    return report;
  }

  /** Upsert the grouping row and return it, with its occurrence count. */
  private async record(
    destinationId: string,
    input: AlertInput,
    now: Date,
    existed: boolean,
  ) {
    return this.prisma.notificationDispatch.upsert({
      where: { destinationId_subject: { destinationId, subject: input.subject } },
      create: {
        id: newId('notificationDispatch'),
        destinationId,
        event: input.event,
        subject: input.subject,
        occurrences: 1,
        firstAt: now,
        lastAt: now,
      },
      update: existed
        ? { lastAt: now, occurrences: { increment: 1 }, event: input.event }
        : { lastAt: now, event: input.event },
    });
  }
}
