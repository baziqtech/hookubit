import { Module } from '@nestjs/common';
import { EndpointSecretsModule } from '../endpoint-secrets/endpoint-secrets.module';
import { EndpointsController } from './endpoints.controller';
import { EndpointHealthService } from './endpoint-health.service';
import { EndpointsService } from './endpoints.service';

/**
 * Depends on `EndpointSecretsModule` in one direction only: creating an
 * endpoint mints its first signing secret, because an active endpoint with no
 * secret is a state the data plane refuses to deliver for.
 */
@Module({
  imports: [EndpointSecretsModule],
  controllers: [EndpointsController],
  providers: [EndpointsService, EndpointHealthService],
  exports: [EndpointsService, EndpointHealthService],
})
export class EndpointsModule {}
