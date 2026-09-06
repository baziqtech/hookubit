import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ErrorCode } from '../common/errors';
import { RequirePermission, ResolveTenantFrom } from './authz.decorators';
import { TenantRequest } from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';
import { TenantGuard } from './tenant.guard';
import { IDS, requestWith, seedWorld } from './testing/fixtures';
import { FakeTenantPrisma } from './testing/tenant-prisma.fake';

/**
 * Real decorators on a real class, read back through a real `Reflector`. The
 * point of this suite is the declarative API a Phase 2 controller will write,
 * so nothing here sets metadata by hand.
 */
class Routes {
  @RequirePermission('endpoints.read')
  readEndpoints(): void {}

  @RequirePermission('endpoints.write')
  writeEndpoints(): void {}

  @RequirePermission('members.write')
  inviteMember(): void {}

  @RequirePermission('billing.write')
  changeBilling(): void {}

  @RequirePermission('deliveries.replay')
  @ResolveTenantFrom('delivery', 'deliveryId')
  replayDelivery(): void {}

  /** No decorator at all: membership is still required, no permission is. */
  membershipOnly(): void {}
}

@RequirePermission('endpoints.read')
class ClassWideRoutes {
  inherited(): void {}

  @RequirePermission('endpoints.write')
  overridden(): void {}
}

function contextFor(
  request: TenantRequest,
  handler: (...args: never[]) => unknown,
  cls: object,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

function build(): { db: FakeTenantPrisma; guard: TenantGuard } {
  const db = seedWorld();
  return { db, guard: new TenantGuard(new Reflector(), new TenantResolver(db.asPrisma())) };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

describe('TenantGuard', () => {
  it('admits a permitted role and attaches the tenant context to the request', async () => {
    const { guard } = build();
    const request = requestWith({ orgId: IDS.orgA, projectId: IDS.projectA1 }, IDS.developerA);

    await expect(
      guard.canActivate(contextFor(request, Routes.prototype.writeEndpoints, Routes)),
    ).resolves.toBe(true);

    expect(request.tenantContext?.organization.id).toBe(IDS.orgA);
    expect(request.tenantContext?.project?.id).toBe(IDS.projectA1);
    expect(request.tenantContext?.role).toBe('developer');
  });

  it('ROLE ESCALATION: a developer attempting members.write gets 403, not a silent pass', async () => {
    const { guard } = build();
    const request = requestWith({ orgId: IDS.orgA }, IDS.developerA);

    const error = await expectCode(
      guard.canActivate(contextFor(request, Routes.prototype.inviteMember, Routes)),
      'forbidden',
    );
    expect(error.details).toMatchObject({
      required_permissions: ['members.write'],
      role: 'developer',
    });
  });

  it('403 for the wrong role INSIDE your tenant; 404 for a tenant that is not yours', async () => {
    const { guard } = build();

    // Member of A, insufficient role -> the resource exists and they know it.
    await expectCode(
      guard.canActivate(
        contextFor(requestWith({ orgId: IDS.orgA }, IDS.viewerA), Routes.prototype.writeEndpoints, Routes),
      ),
      'forbidden',
    );

    // Not a member of B at all -> B's existence is not disclosed.
    await expectCode(
      guard.canActivate(
        contextFor(requestWith({ orgId: IDS.orgB }, IDS.ownerA), Routes.prototype.readEndpoints, Routes),
      ),
      'not_found',
    );
  });

  it('answers 404 for a user with no membership anywhere', async () => {
    const { guard } = build();
    await expectCode(
      guard.canActivate(
        contextFor(requestWith({ orgId: IDS.orgA }, IDS.stranger), Routes.prototype.readEndpoints, Routes),
      ),
      'not_found',
    );
  });

  it('answers 404 for a project belonging to another organization than the route says', async () => {
    const { guard } = build();
    await expectCode(
      guard.canActivate(
        contextFor(
          requestWith({ orgId: IDS.orgA, projectId: IDS.projectB1 }, IDS.ownerA),
          Routes.prototype.readEndpoints,
          Routes,
        ),
      ),
      'not_found',
    );
  });

  it('refuses admin billing.write - the matrix, enforced through the guard', async () => {
    const { guard } = build();
    await expectCode(
      guard.canActivate(
        contextFor(requestWith({ orgId: IDS.orgA }, IDS.adminA), Routes.prototype.changeBilling, Routes),
      ),
      'forbidden',
    );
    await expect(
      guard.canActivate(
        contextFor(requestWith({ orgId: IDS.orgA }, IDS.billingA), Routes.prototype.changeBilling, Routes),
      ),
    ).resolves.toBe(true);
  });

  it('enforces the anchor route: an owner of A cannot replay B deliveries', async () => {
    const { guard } = build();
    await expect(
      guard.canActivate(
        contextFor(
          requestWith({ deliveryId: IDS.deliveryA1 }, IDS.ownerA),
          Routes.prototype.replayDelivery,
          Routes,
        ),
      ),
    ).resolves.toBe(true);

    await expectCode(
      guard.canActivate(
        contextFor(
          requestWith({ deliveryId: IDS.deliveryB1 }, IDS.ownerA),
          Routes.prototype.replayDelivery,
          Routes,
        ),
      ),
      'not_found',
    );
  });

  it('still resolves and enforces the tenant on a handler with no permission declared', async () => {
    const { guard } = build();
    const request = requestWith({ orgId: IDS.orgA }, IDS.viewerA);
    await expect(
      guard.canActivate(contextFor(request, Routes.prototype.membershipOnly, Routes)),
    ).resolves.toBe(true);
    expect(request.tenantContext?.role).toBe('viewer');

    await expectCode(
      guard.canActivate(
        contextFor(requestWith({ orgId: IDS.orgA }, IDS.stranger), Routes.prototype.membershipOnly, Routes),
      ),
      'not_found',
    );
  });

  it('lets a handler declaration override a class-wide one', async () => {
    const { guard } = build();
    const viewer = requestWith({ orgId: IDS.orgA }, IDS.viewerA);

    await expect(
      guard.canActivate(contextFor(viewer, ClassWideRoutes.prototype.inherited, ClassWideRoutes)),
    ).resolves.toBe(true);

    await expectCode(
      guard.canActivate(
        contextFor(
          requestWith({ orgId: IDS.orgA }, IDS.viewerA),
          ClassWideRoutes.prototype.overridden,
          ClassWideRoutes,
        ),
      ),
      'forbidden',
    );
  });

  it('refuses a request that never went through SessionGuard', async () => {
    const { guard } = build();
    const request = requestWith({ orgId: IDS.orgA });
    await expectCode(
      guard.canActivate(contextFor(request, Routes.prototype.readEndpoints, Routes)),
      'unauthenticated',
    );
  });

  it('denies writes in a suspended organization and says why', async () => {
    const { guard } = build();
    const request = requestWith({ orgId: IDS.orgSuspended }, IDS.ownerSuspended);

    const error = await expectCode(
      guard.canActivate(contextFor(request, Routes.prototype.writeEndpoints, Routes)),
      'forbidden',
    );
    expect(error.message).toMatch(/suspended/i);

    await expect(
      guard.canActivate(
        contextFor(
          requestWith({ orgId: IDS.orgSuspended }, IDS.ownerSuspended),
          Routes.prototype.changeBilling,
          Routes,
        ),
      ),
    ).resolves.toBe(true);
  });
});
