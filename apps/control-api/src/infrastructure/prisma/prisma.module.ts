import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * NOT `@Global()`.
 *
 * Global made `PrismaService` injectable in a feature module whose file
 * contained no mention of it at all - the raw, unscoped client available with
 * no import statement for a reviewer to notice. A module that wants the
 * database now says so in `imports`, which is where the review question "why
 * does this module talk to Prisma instead of TenantScopeFactory?" gets asked.
 *
 * `.eslintrc.json` bans importing the service outside the allowlisted layers;
 * this is the other half of the same fence.
 */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
