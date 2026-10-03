import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { MAILER_PORT } from '../auth/mailer.port';
import {
  NotificationConfirmationController,
  NotificationDestinationsController,
} from './notification-destinations.controller';
import { NotificationConfirmationService } from './notification-confirmation.service';
import { NotificationDestinationsService } from './notification-destinations.service';
import { OPERATIONAL_MAILER, OperationalMailer } from './operational-mailer.port';

/**
 * Alert destinations.
 *
 * `OPERATIONAL_MAILER` resolves to whatever `MAILER_PORT` resolved to, because
 * `SmtpMailer` implements both ports and the selection between it and the
 * development stub is already made once, in `AuthModule`. Repeating that
 * decision here is how the two halves of the product end up disagreeing about
 * whether mail works.
 *
 * The stub does not implement the operational methods, which is why the cast is
 * narrowed at the boundary rather than asserted inside the service: with no
 * SMTP configured, a create still writes its row and records that the
 * confirmation could not be sent — the state the UI is built to show.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [NotificationDestinationsController, NotificationConfirmationController],
  providers: [
    NotificationDestinationsService,
    NotificationConfirmationService,
    {
      provide: OPERATIONAL_MAILER,
      inject: [MAILER_PORT],
      useFactory: (mailer: Partial<OperationalMailer>): OperationalMailer => ({
        async sendNotificationConfirmation(email, input) {
          if (!mailer.sendNotificationConfirmation) {
            throw new Error(
              'No SMTP transport is configured, so the confirmation could not be sent. Set SMTP_URL.',
            );
          }
          await mailer.sendNotificationConfirmation(email, input);
        },
        async sendNotificationAlert(email, input) {
          if (!mailer.sendNotificationAlert) {
            throw new Error(
              'No SMTP transport is configured, so the alert could not be sent. Set SMTP_URL.',
            );
          }
          await mailer.sendNotificationAlert(email, input);
        },
      }),
    },
  ],
  exports: [NotificationDestinationsService, OPERATIONAL_MAILER],
})
export class NotificationDestinationsModule {}
