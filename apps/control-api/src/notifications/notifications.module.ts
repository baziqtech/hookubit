import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAIL_TRANSPORT } from './mail-transport';
import { createMailTransport } from './mailer-selection';

/**
 * Outbound mail (ARCHITECTURE.md 9: email verification, password reset,
 * invitations).
 *
 * This module owns exactly one thing: the SMTP transport, built once from
 * `SMTP_URL` + `MAIL_FROM` and shared by every port that sends mail. It does
 * NOT bind the ports themselves - `MAILER_PORT` stays in `AuthModule` and
 * `INVITATION_MAILER` in `MembersModule`, each choosing between `SmtpMailer`
 * and its own development stub through `selectMailer`. The ports have
 * different consumers and different audiences, and neither module should have
 * to import the other to send mail.
 *
 * The provider is `null` when `SMTP_URL` is unset. That is a legal state in
 * development and test and a refused one everywhere else - refused by the
 * schema at boot and again by `selectMailer`, by name.
 */
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: createMailTransport,
    },
  ],
  exports: [MAIL_TRANSPORT],
})
export class NotificationsModule {}
