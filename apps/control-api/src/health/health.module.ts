import { Module } from '@nestjs/common';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { HealthController } from './health.controller';

// PrismaModule is imported explicitly: it is no longer @Global.
@Module({ imports: [PrismaModule], controllers: [HealthController] })
export class HealthModule {}
