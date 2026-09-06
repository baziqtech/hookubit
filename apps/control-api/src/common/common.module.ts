import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';
import { ThrottleGuard } from './throttle.guard';
import { THROTTLE_STORE, ThrottleStore, createThrottleStore } from './throttle.store';

@Global()
@Module({
  providers: [
    CryptoService,
    {
      // Redis whenever REDIS_URL is configured, so the limit is shared across
      // replicas (FIX 1c); per-process otherwise, with a loud warning.
      provide: THROTTLE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ThrottleStore =>
        createThrottleStore(config.get<string>('REDIS_URL'), new Logger('ThrottleStore')),
    },
    ThrottleGuard,
  ],
  exports: [CryptoService, ThrottleGuard, THROTTLE_STORE],
})
export class CommonModule {}
