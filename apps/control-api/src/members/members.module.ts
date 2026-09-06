import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations';
import { InvitationsController } from './invitations.controller';
import { DevelopmentInvitationMailer, INVITATION_MAILER } from './invitation-mailer.port';
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
 * Swap `INVITATION_MAILER` for a real transport when the notifications module
 * lands - nothing else has to change.
 */
@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [MembersController, InvitationsController],
  providers: [MembersService, { provide: INVITATION_MAILER, useClass: DevelopmentInvitationMailer }],
  exports: [MembersService],
})
export class MembersModule {}
