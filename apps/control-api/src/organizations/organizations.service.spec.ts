import { AuditService, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { MAX_ORGANIZATIONS_PER_USER, OrganizationsService } from './organizations.service';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from './dto';
import { TenantTransactionRunner } from './tenant-transaction';
import { FakeWorld, IDS, principalFor, seedWorld, contextFor } from './testing/world';
import { UserScope, UserScopeFactory } from './user-scope';

describe('OrganizationsService', () => {
  let db: FakeWorld;
  let audit: AuditService;
  let service: OrganizationsService;

  beforeEach(() => {
    db = seedWorld();
    audit = new AuditService(db.asPrisma());
    const scopes = new TenantScopeFactory(db.asPrisma());
    service = new OrganizationsService(
      new UserScopeFactory(db.asPrisma()),
      scopes,
      audit,
      new TenantTransactionRunner(db.asPrisma(), scopes, audit),
    );
  });

  /** A project in an organization, with the columns PostgreSQL would default. */
  const seedProject = (organizationId: string, id: string, status = 'active'): void => {
    db.insert('project', {
      id,
      organizationId,
      name: id,
      slug: id,
      environment: 'test',
      status,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  };

  const statusOf = (table: string, id: string): unknown => db.rows(table).get(id)?.status;

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

    // -------------------------------------------------------------------------
    // FIX 4 - a derived slug must satisfy the pattern its own DTO declares
    // -------------------------------------------------------------------------

    it('never derives a slug that its own DTO would reject', async () => {
      // The truncation used to happen AFTER the edge-hyphen strip and was never
      // re-tested, so a name whose cut lands on a separator wrote a trailing
      // hyphen. The name below is built so the 48-character slice falls exactly
      // on one.
      const head = 'a'.repeat(SLUG_MAX_LENGTH - 1);
      const created = await service.create(principalFor(IDS.outsider), {
        name: `${head} and partners`,
      });

      expect(created.slug).toMatch(SLUG_PATTERN);
      expect(created.slug.endsWith('-')).toBe(false);
      expect(created.slug).not.toContain('--');
      expect(created.slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    });

    it('accepts its own derived slug back on a PATCH', async () => {
      // The actual user-visible bug: the value create wrote was rejected as
      // invalid when the owner sent it back unchanged. Rather than re-deriving
      // by hand, run the derivation over a spread of hostile names and check
      // every result against the pattern the DTO enforces on the way in.
      const names = [
        `${'b'.repeat(SLUG_MAX_LENGTH - 1)} and partners`,
        `${'c'.repeat(SLUG_MAX_LENGTH)}!!!!`,
        'Acme -- Corporation',
        '  spaced  out  ',
        '!!!',
        'a-',
      ];

      for (const name of names) {
        const created = await service.create(principalFor(IDS.outsider), { name });
        expect({ name, slug: created.slug }).toMatchObject({
          slug: expect.stringMatching(SLUG_PATTERN),
        });
      }
    });

    // -------------------------------------------------------------------------
    // FIX 7 - a per-account bound on an untenanted write
    // -------------------------------------------------------------------------

    it('refuses to create past the per-account cap', async () => {
      for (let i = 0; i < MAX_ORGANIZATIONS_PER_USER; i += 1) {
        await service.create(principalFor(IDS.outsider), { name: `Org ${i}` });
      }
      // outsider owns none from the seed, so the cap is reached exactly here.
      expect(await code(service.create(principalFor(IDS.outsider), { name: 'One too many' }))).toBe(
        'conflict',
      );
    });

    it('counts only organizations the caller OWNS, not ones they were invited to', async () => {
      // viewerA is a member of org A at viewer rank. That is somebody else's
      // decision and must not consume their own allowance.
      const created = await service.create(principalFor(IDS.viewerA), { name: 'Mine' });
      expect(created.role).toBe('owner');
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

  // ---------------------------------------------------------------------------
  // FIX 2 - deletion has to stop INGEST, not just the control plane
  // ---------------------------------------------------------------------------

  describe('remove also retires the projects', () => {
    it("soft-deletes every project, because that is the gate the data plane reads", async () => {
      // The data plane never reads `organizations`: `findAPIKeySQL` joins
      // api_keys -> projects and the handler gates on ProjectStatus. Leaving the
      // projects active meant every wk_live_ key kept authenticating and events
      // kept being stored after the organization was "deleted" - while every
      // member was locked out of the control plane and could not revoke them.
      seedProject(IDS.orgA, 'prj_a1');
      seedProject(IDS.orgA, 'prj_a2');
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      await service.remove(context);

      expect(statusOf('project', 'prj_a1')).toBe('deleted');
      expect(statusOf('project', 'prj_a2')).toBe('deleted');
      expect(statusOf('organization', IDS.orgA)).toBe('deleted');
    });

    it("does not touch another organization's projects", async () => {
      seedProject(IDS.orgA, 'prj_a1');
      seedProject(IDS.orgB, 'prj_b1');
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      await service.remove(context);

      expect(statusOf('project', 'prj_b1')).toBe('active');
      expect(statusOf('organization', IDS.orgB)).toBe('active');
    });

    it('is one transaction: a failure leaves the organization administrable', async () => {
      // The half-applied state is the dangerous one. If the organization were
      // marked deleted and the projects were not, every member would be locked
      // out of a tenant that is still ingesting - and there is no undelete.
      seedProject(IDS.orgA, 'prj_a1');
      jest.spyOn(audit, 'recordFor').mockRejectedValue(new Error('audit write failed'));
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      await expect(service.remove(context)).rejects.toThrow('audit write failed');

      expect(statusOf('organization', IDS.orgA)).toBe('active');
      expect(statusOf('project', 'prj_a1')).toBe('active');
    });

    it('records how many projects went with it', async () => {
      seedProject(IDS.orgA, 'prj_a1');
      seedProject(IDS.orgA, 'prj_a2');
      seedProject(IDS.orgA, 'prj_gone', 'deleted');
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      await service.remove(context);

      expect(db.all('auditLog')).toContainEqual(
        expect.objectContaining({
          action: 'organization.deleted',
          organizationId: IDS.orgA,
          // The already-deleted one is not counted twice.
          metadata: expect.objectContaining({ projects_deleted: 2 }),
        }),
      );
    });

    it('leaves the delivery-bearing rows alone: this is a status flip, not a cascade', async () => {
      seedProject(IDS.orgA, 'prj_a1');
      const context = await contextFor(db, IDS.ownerA, IDS.orgA);

      await service.remove(context);

      expect(db.rows('project').has('prj_a1')).toBe(true);
      expect(db.rows('organization').has(IDS.orgA)).toBe(true);
      expect(db.all('organizationMember').some((row) => row.organizationId === IDS.orgA)).toBe(true);
    });
  });
});
