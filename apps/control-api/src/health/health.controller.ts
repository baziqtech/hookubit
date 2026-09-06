import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * Liveness must NOT depend on PostgreSQL (ARCHITECTURE.md 46) - a database
 * blip should not cause Kubernetes to kill every control-plane pod.
 * Readiness may check dependencies.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @ApiExcludeEndpoint()
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiExcludeEndpoint()
  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { postgres: 'down' },
      });
    }
    return { status: 'ok', checks: { postgres: 'up' } };
  }
}
