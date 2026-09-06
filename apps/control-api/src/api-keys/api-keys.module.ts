import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

/**
 * No imports: `AuthzModule` is `@Global` and re-exports `AuthModule`, so the
 * scope factory, the audit service and both guards resolve here. `PrismaService`
 * is not injected anywhere in this module - a key lookup by hash belongs to the
 * data plane, and giving the control plane an unscoped `key_hash` query would
 * be a cross-tenant read waiting for a caller.
 */
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
