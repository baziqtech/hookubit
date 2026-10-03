import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { MAIL_TRANSPORT, MailTransport, NotificationsModule, SmtpMailer, selectMailer } from '../notifications';
import { OrganizationsModule } from '../organizations';
import { InvitationsController } from './invitations.controller';
import {
  DevelopmentInvitationMailer,
  INVITATION_MAILER,
  InvitationMailer,
} from './invitation-mailer.port';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * Memberships and invitations.
 *
 * `AuthModule` for `TokenService` - the `user_tokens` table already has an
 * `invitation` type and the hashing, single-use consumption and expiry are
 * already solved there. A second token scheme in this module would be a second
 * thing to get wrong.
 *
 * `OrganizationsModule` for `UserScopeFactory` (redemption is user-scoped),
 * `UserDirectory` (member identities) and `TenantTransactionRunner` (the
 * owner-count-and-write transaction). All three belong in `src/authz`; when
 * they move, this import becomes unnecessary.
 *
 * `INVITATION_MAILER` is chosen at boot by the same rule as `AuthModule`'s
 * `MAILER_PORT`: SMTP when `SMTP_URL` is set, the logging stub otherwise and
 * only in development/test. The two ports stay separate - different
 * consumers, different audiences - and share one transport instance through
 * `NotificationsModule`.
 */
@Module({
  imports: [AuthModule, OrganizationsModule, NotificationsModule],
  controllers: [MembersController, InvitationsController],
  providers: [
    MembersService,
    {
      provide: INVITATION_MAILER,
      inject: [ConfigService, MAIL_TRANSPORT],
      useFactory: (config: ConfigService, transport: MailTransport | null): InvitationMailer =>
        selectMailer<InvitationMailer>(config, transport, {
          smtp: (smtp, context) => new SmtpMailer(smtp, context),
          stub: () => new DevelopmentInvitationMailer(config),
        }),
    },
  ],
  exports: [MembersService],
})
export class MembersModule {}
