import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { prismaTracingMiddleware } from '../../tracing/prisma-tracing';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    // Installed unconditionally, not behind a config check, because module
    // initialisation order between this and `TracerProviderService` is not
    // something Nest promises and a hook that is sometimes absent is worse than
    // one that is always present. The hook itself is the switch: with tracing
    // off it is a single boolean read and a passthrough, and with tracing off
    // is the normal state of a self-hosted install. See tracing/prisma-tracing.ts
    // for what it records - the model and the operation - and, more importantly,
    // what it never records: `params.args`.
    this.$use(prismaTracingMiddleware());

    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
