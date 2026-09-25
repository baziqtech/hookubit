import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CommonModule } from '../common/common.module';
import { AutoDisableScheduler } from './auto-disable.scheduler';
import { EndpointAutoDisableService } from './endpoint-auto-disable.service';
import { MaintenanceModule } from './maintenance.module';

/**
 * The DI graph, compiled for real.
 *
 * Every other suite in this module constructs the providers by hand, which is
 * right for testing behaviour and blind to wiring: a missing `imports` entry
 * compiles, type-checks and passes all of them, then throws at boot. This
 * module shipped exactly that bug once - `PrismaModule` is deliberately not
 * `@Global()`, and the class docblock's own claim that it is was wrong.
 *
 * `ConfigModule` and `CommonModule` are imported here because `AppModule`
 * registers both and both are global there - this reproduces the production
 * arrangement rather than papering over it. `PrismaModule` is deliberately NOT
 * global, so nothing here can mask its absence, which is the point of the test.
 */
describe('MaintenanceModule', () => {
  it('resolves every provider it declares', async () => {
    // Never connected: `compile()` instantiates providers without running
    // lifecycle hooks, so `PrismaService.onModuleInit` does not fire. The value
    // only has to satisfy PrismaClient's constructor.
    process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unused';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        CommonModule,
        MaintenanceModule,
      ],
    }).compile();

    expect(moduleRef.get(EndpointAutoDisableService)).toBeInstanceOf(EndpointAutoDisableService);
    expect(moduleRef.get(AutoDisableScheduler)).toBeInstanceOf(AutoDisableScheduler);

    await moduleRef.close();
  });
});
