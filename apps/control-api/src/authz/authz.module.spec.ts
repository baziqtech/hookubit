import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SessionGuard } from '../auth/session.guard';
import { assertRoutesAreGuarded, findUnguardedRoutes } from './authz.module';
import { Authorized, RequirePermission, ResolveTenantFrom } from './authz.decorators';
import { TenantGuard } from './tenant.guard';

/**
 * `@RequirePermission` and `@ResolveTenantFrom` are bare `SetMetadata`. They
 * enforce nothing; the guard reads them. A controller that declares one and
 * forgets `@Authorized()` looks authorized in review, passes the compiler,
 * passes every unit test - and serves the route to anyone.
 *
 * The boot assertion is the thing that notices. These controllers are the
 * mistakes it has to catch.
 */
@Controller('safe')
class GuardedController {
  @Get()
  @Authorized('endpoints.read')
  list(): string {
    return 'ok';
  }
}

@Controller('unsafe')
class BarePermissionController {
  @Get()
  @RequirePermission('api-keys.read')
  list(): string {
    return 'ok';
  }

  @Post()
  @RequirePermission('api-keys.write')
  create(): string {
    return 'ok';
  }
}

@Controller('unsafe-anchor')
class BareAnchorController {
  @Get(':endpointId')
  @ResolveTenantFrom('endpoint', 'endpointId')
  show(): string {
    return 'ok';
  }
}

@Controller('open')
class PublicController {
  @Get()
  ping(): string {
    return 'pong';
  }
}

/** The class-level form: one `@Authorized()` covering every handler. */
@Controller('class-guarded')
@Authorized()
class ClassGuardedController {
  @Get()
  @RequirePermission('events.read')
  list(): string {
    return 'ok';
  }
}

async function appWith(...controllers: Array<new (...args: never[]) => unknown>): Promise<INestApplication> {
  // Nest instantiates route guards while compiling the module, so both are
  // stubbed. The assertion reads the metadata, not the instances.
  const allow = { canActivate: (): boolean => true };
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: controllers as never,
  })
    .overrideGuard(SessionGuard)
    .useValue(allow)
    .overrideGuard(TenantGuard)
    .useValue(allow)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('boot assertion: authorization metadata implies an enforcing guard', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('passes a controller that uses @Authorized', async () => {
    app = await appWith(GuardedController, PublicController);
    expect(findUnguardedRoutes(app)).toEqual([]);
    expect(() => assertRoutesAreGuarded(app as INestApplication)).not.toThrow();
  });

  it('accepts a class-level @Authorized covering a handler-level @RequirePermission', async () => {
    app = await appWith(ClassGuardedController);
    expect(findUnguardedRoutes(app)).toEqual([]);
  });

  it('catches every handler that declares a permission with no guard mounted', async () => {
    app = await appWith(BarePermissionController);
    const offenders = findUnguardedRoutes(app);
    expect(offenders.map((offender) => offender.handler).sort()).toEqual(['create', 'list']);
    expect(offenders[0].controller).toBe('BarePermissionController');
    expect(offenders[0].reason).toContain('TenantGuard is not mounted');
  });

  it('catches a bare @ResolveTenantFrom too - it names a tenant nobody resolves', async () => {
    app = await appWith(BareAnchorController);
    expect(findUnguardedRoutes(app)).toEqual([
      {
        controller: 'BareAnchorController',
        handler: 'show',
        reason: expect.stringContaining('@ResolveTenantFrom'),
      },
    ]);
  });

  it('says nothing about a route that declares no authorization metadata at all', async () => {
    app = await appWith(PublicController);
    expect(findUnguardedRoutes(app)).toEqual([]);
  });

  it('FAILS THE DEPLOY, naming the routes, rather than failing one request', async () => {
    app = await appWith(GuardedController, BarePermissionController, BareAnchorController);
    let message = '';
    try {
      assertRoutesAreGuarded(app);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('3 route(s)');
    expect(message).toContain('BarePermissionController.list');
    expect(message).toContain('BareAnchorController.show');
    expect(message).not.toContain('GuardedController');
  });
});
