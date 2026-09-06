import { AuditService, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { OrganizationsService } from './organizations.service';
import { FakeWorld, IDS, principalFor, seedWorld, contextFor } from './testing/world';
import { UserScope, UserScopeFactory } from './user-scope';

describe('OrganizationsService', () => {
  let db: FakeWorld;
  let audit: AuditService;
  let service: OrganizationsService;

  beforeEach(() => {
    db = seedWorld();
    audit = new AuditService(db.asPrisma());
    service = new OrganizationsService(
      new UserScopeFactory(db.asPrisma()),
      new TenantScopeFactory(db.asPrisma()),
      audit,
    );
  });

  const code = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
    } catch (err) {
      if (err instanceof AppError) return err.code;
      throw err;
    }
    throw new Error('expected the call to be refused, but it resolved');
  };

  // ---------------------------------------------------------------------------
  // Listing - the untenanted IDOR surface
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('returns only the organizations the caller belongs to', async () => {
      const result = await service.list(principalFor(IDS.ownerA), {});

      expect(result.data.map((row) => row.id)).toEqual([IDS.orgA]);
      expect(result.total).toBe(1);
      // The point of the assertion: org B was sitting in the same table.
      expect(db.all('organization').map((row) => row.id)).toContain(IDS.orgB);
    });

    it("does not leak an organization the caller was never a member of", async () => {
      const result = await service.list(principalFor(IDS.ownerB), {});
      expect(result.data.map((row) => row.id)).toEqual([IDS.orgB]);
    });

    it('returns nothing at all for a user with no memberships', async () => {
      const result = await service.list(principalFor(IDS.outsider), {});
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('omits soft-deleted organizations even though the membership row survives', async () => {
      // ownerA is a member of org_gone; TenantResolver would 404 every route
      // under it, so it must not appear in the switcher either.
      const result = await service.list(principalFor(IDS.ownerA), {});
      expect(result.data.map((row) => row.id)).not.toContain(IDS.orgDeleted);
      expect(db.rows('organizationMember').has(`mem_${IDS.ownerA}_${IDS.orgDeleted}`)).toBe(true);
    });

    it("carries the caller's own role on each row", async () => {
      const asOwner = await service.list(principalFor(IDS.ownerA), {});
      const asViewer = await service.list(principalFor(IDS.viewerA), {});
      expect(asOwner.data[0].role).toBe('owner');
      expect(asViewer.data[0].role).toBe('viewer');
    });

    it('clamps a page size above the repository ceiling', async () => {
      const result = await service.list(principalFor(IDS.ownerA), { limit: 10_000 });
      expect(result.data.length).toBeLessThanOrEqual(200);
    });
  });

  describe('UserScope', () => {
    it('refuses to construct without a user id, rather than building an unfiltered query', () => {
      // Prisma reads `{ userId: undefined }` as "no filter", so a scope built
      // from an empty principal would list every membership on the platform.
      expect(() =>
        UserScope.create(db.asPrisma(), {
          userId: '',
          email: 'nobody@example.com',
          sessionId: 'ses_x',
          ipAddress: null,
          userAgent: null,
        }),
      ).toThrow(AppError);
    });
  });

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  describe('create', () => {
    it('makes the caller the owner and writes the organization, membership and audit row', async () => {
      const created = await service.create(principalFor(IDS.outsider), { name: 'Umbrella' });

      expect(created.role).toBe('owner');
      expect(created.slug).toBe('umbrella');

      const membership = db
        .all('organizationMember')
        .find((row) => row.organizationId === created.id);
      expect(membership).toMatchObject({ userId: IDS.outsider, role: 'owner' });

      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({
          organizationId: created.id,
          userId: IDS.outsider,
          action: 'organization.created',
          resourceType: 'organization',
        }),
      );
    });

    it('binds the owner membership to the session user, with no user id in the input', async () => {
      // There is no parameter that could name a different user. This is the
      // structural answer to "can I create an organization owned by someone
      // else, or add myself to one I was not invited to?".
      const created = await service.create(principalFor(IDS.viewerA), { name: 'Soylent' });
      const memberships = db
        .all('organizationMember')
        .filter((row) => row.organizationId === created.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].userId).toBe(IDS.viewerA);
    });

    it('is atomic: a failure after the inserts leaves no organization and no membership', async () => {
      jest.spyOn(audit, 'recordFor').mockRejectedValue(new Error('audit write failed'));
      const before = db.all('organization').length;

      await expect(service.create(principalFor(IDS.outsider), { name: 'Tyrell' })).rejects.toThrow(
        'audit write failed',
      );

      expect(db.all('organization')).toHaveLength(before);
      expect(db.all('organization').some((row) => row.slug === 'tyrell')).toBe(false);
      expect(db.all('organizationMember').some((row) => row.userId === IDS.outsider)).toBe(false);
    });

    it('retries a derived slug that is already taken instead of failing', async () => {
      // "Acme" slugifies to "acme", which the seeded organization holds.
      const created = await service.create(principalFor(IDS.outsider), { name: 'Acme' });
      expect(created.slug).not.toBe('acme');
      expect(created.slug).toMatch(/^acme-[a-z0-9]{6}$/);
    });

    it('refuses an explicitly requested slug that is taken, rather than silently suffixing it', async () => {
      expect(
        await code(service.create(principalFor(IDS.outsider), { name: 'Globex II', slug: 'globex' })),
      ).toBe('conflict');
    });

    it('falls back to a suffixed default when the name has nothing slug-safe in it', async () => {
      const created = await service.create(principalFor(IDS.outsider), { name: '!!!' });
      expect(created.slug).toMatch(/^workspace-[a-z0-9]{6}$/);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant-scoped reads and writes
  // ---------------------------------------------------------------------------

  describe('get / update / remove', () => {
    it('reads the organization behind the resolved context', async () => {
      const context = await contextFor(db, IDS.developerA, IDS.orgA);
      const organization = await service.get(context);
      expect(organization).toMatchObject({ id: IDS.orgA, slug: 'acme', role: 'developer' });
    });

    it('renames and audits the before and after', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      const updated = await service.update(context, { name: 'Acme Corporation' });

      expect(updated.name).toBe('Acme Corporation');
      expect(db.rows('organization').get(IDS.orgA)?.name).toBe('Acme Corporation');
      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({
          action: 'organization.updated',
          organizationId: IDS.orgA,
          metadata: expect.objectContaining({
            from: { name: 'Acme', slug: 'acme' },
            to: { name: 'Acme Corporation', slug: 'acme' },
          }),
        }),
      );
    });

    it('refuses an empty patch rather than writing nothing and reporting success', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(await code(service.update(context, {}))).toBe('invalid_request');
    });

    it('reports a taken slug as a conflict', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(await code(service.update(context, { slug: 'globex' }))).toBe('conflict');
      expect(db.rows('organization').get(IDS.orgA)?.slug).toBe('acme');
    });

    it('soft-deletes for an owner: status only, the row survives', async () => {
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);
      await service.remove(context);

      const row = db.rows('organization').get(IDS.orgA);
      expect(row).toBeDefined();
      expect(row?.status).toBe('deleted');
      // The membership rows are untouched: the delivery ledger hangs off this
      // chain and nothing here may cascade.
      expect(db.all('organizationMember').some((m) => m.organizationId === IDS.orgA)).toBe(true);
      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({ action: 'organization.deleted', organizationId: IDS.orgA }),
      );
    });

    it('refuses deletion for an admin, who may otherwise write the organization', async () => {
      const context = await contextFor(db, IDS.adminA, IDS.orgA);
      expect(await code(service.remove(context))).toBe('forbidden');
      expect(db.rows('organization').get(IDS.orgA)?.status).toBe('active');
    });
  });
});
