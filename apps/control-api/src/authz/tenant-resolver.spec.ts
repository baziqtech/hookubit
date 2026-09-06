import { Logger } from '@nestjs/common';
import { AppError, ErrorCode } from '../common/errors';
import {
  DEFAULT_TENANT_SPEC,
  RequestContext,
  TenantAnchorKind,
  TenantSpec,
} from './tenant-context';
import { CROSS_TENANT_MESSAGE, TenantResolver } from './tenant-resolver.service';
import { IDS, requestWith, seedWorld, sessionUser } from './testing/fixtures';
import { FakeTenantPrisma } from './testing/tenant-prisma.fake';

// The resolver records the specific reason for every refusal at debug level.
// Silence it here so the suite's output stays readable; one test below asserts
// it is still emitted.
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

/** Asserts the AppError code, which IS the not-found/forbidden policy. */
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

function build(): { db: FakeTenantPrisma; resolver: TenantResolver } {
  const db = seedWorld();
  return { db, resolver: new TenantResolver(db.asPrisma()) };
}

function resolve(
  resolver: TenantResolver,
  userId: string,
  params: Record<string, string>,
  spec: TenantSpec = DEFAULT_TENANT_SPEC,
): Promise<RequestContext> {
  return resolver.resolve(sessionUser(userId), requestWith(params, userId), spec);
}

describe('TenantResolver - route parameters', () => {
  it('resolves the organization, membership and role for a member', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.adminA, { orgId: IDS.orgA });

    expect(context.organization.id).toBe(IDS.orgA);
    expect(context.role).toBe('admin');
    expect(context.project).toBeNull();
    expect(context.has('endpoints.write')).toBe(true);
    expect(context.has('billing.write')).toBe(false);
    expect(context.membershipId).toBe(`mem_${IDS.adminA}_${IDS.orgA}`);
  });

  it('captures the caller address and user agent for the audit trail', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.ownerA, { orgId: IDS.orgA });
    expect(context.ipAddress).toBe('203.0.113.9');
    expect(context.userAgent).toBe('jest');
  });

  it('answers 404, not 403, for a user with no membership in the target organization', async () => {
    const { resolver } = build();
    await expectCode(resolve(resolver, IDS.stranger, { orgId: IDS.orgA }), 'not_found');
  });

  it('answers 404 for a member of A asking about organization B', async () => {
    const { resolver } = build();
    await expectCode(resolve(resolver, IDS.ownerA, { orgId: IDS.orgB }), 'not_found');
  });

  it('answers 404 for an organization id that does not exist at all', async () => {
    const { resolver } = build();
    await expectCode(resolve(resolver, IDS.ownerA, { orgId: 'org_nope' }), 'not_found');
  });

  it('gives the same message for "not yours" and "does not exist"', async () => {
    const { resolver } = build();
    const foreign = await expectCode(resolve(resolver, IDS.ownerA, { orgId: IDS.orgB }), 'not_found');
    const absent = await expectCode(resolve(resolver, IDS.ownerA, { orgId: 'org_nope' }), 'not_found');
    expect(foreign.message).toBe(absent.message);
  });

  it('resolves a project nested under its own organization', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.developerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    expect(context.project?.id).toBe(IDS.projectA1);
    expect(context.requireProject().organizationId).toBe(IDS.orgA);
  });

  it('THE IDOR: refuses /orgs/A/projects/<B project> even though the caller owns A', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(resolver, IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectB1 }),
      'not_found',
    );
  });

  it('derives the organization from a project-only route and still checks membership', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.ownerA, { projectId: IDS.projectA1 });
    expect(context.organization.id).toBe(IDS.orgA);

    await expectCode(resolve(resolver, IDS.ownerA, { projectId: IDS.projectB1 }), 'not_found');
  });

  it('treats a soft-deleted project as absent', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(resolver, IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectADeleted }),
      'not_found',
    );
  });

  it('treats a soft-deleted organization as absent, even for its owner', async () => {
    const { db, resolver } = build();
    db.rows('organization').set(IDS.orgA, {
      ...(db.rows('organization').get(IDS.orgA) as Record<string, unknown>),
      status: 'deleted',
    });
    await expectCode(resolve(resolver, IDS.ownerA, { orgId: IDS.orgA }), 'not_found');
  });

  it('narrows an owner of a suspended organization to reads plus billing.write', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.ownerSuspended, { orgId: IDS.orgSuspended });
    expect(context.role).toBe('owner');
    expect(context.has('projects.read')).toBe(true);
    expect(context.has('billing.write')).toBe(true);
    expect(context.has('endpoints.write')).toBe(false);
  });

  it('narrows on a suspended project inside a healthy organization', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectASuspended,
    });
    expect(context.has('endpoints.read')).toBe(true);
    expect(context.has('endpoints.write')).toBe(false);
  });

  it('fails loudly - not silently open - on a guarded route that names no tenant', async () => {
    const { resolver } = build();
    await expectCode(resolve(resolver, IDS.ownerA, {}), 'internal_error');
  });

  it('rejects requireProject() on an organization-only route', async () => {
    const { resolver } = build();
    const context = await resolve(resolver, IDS.ownerA, { orgId: IDS.orgA });
    expect(() => context.requireProject()).toThrow(AppError);
  });
});

describe('TenantResolver - resource anchors', () => {
  const anchor = (kind: TenantAnchorKind, param: string): TenantSpec => ({
    from: 'anchor',
    kind,
    param,
  });

  it('walks endpoint -> project -> organization', async () => {
    const { resolver } = build();
    const context = await resolve(
      resolver,
      IDS.developerA,
      { endpointId: IDS.endpointA1 },
      anchor('endpoint', 'endpointId'),
    );
    expect(context.organization.id).toBe(IDS.orgA);
    expect(context.project?.id).toBe(IDS.projectA1);
  });

  it('refuses another tenant endpoint addressed directly by id', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(
        resolver,
        IDS.ownerA,
        { endpointId: IDS.endpointB1 },
        anchor('endpoint', 'endpointId'),
      ),
      'not_found',
    );
  });

  it('walks delivery -> endpoint -> project -> organization', async () => {
    const { resolver } = build();
    const context = await resolve(
      resolver,
      IDS.ownerA,
      { deliveryId: IDS.deliveryA1 },
      anchor('delivery', 'deliveryId'),
    );
    expect(context.organization.id).toBe(IDS.orgA);
    expect(context.project?.id).toBe(IDS.projectA1);
  });

  it('refuses another tenant delivery', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(
        resolver,
        IDS.ownerA,
        { deliveryId: IDS.deliveryB1 },
        anchor('delivery', 'deliveryId'),
      ),
      'not_found',
    );
  });

  it('refuses a delivery whose denormalised org/project columns disagree with the endpoint chain', async () => {
    const { resolver } = build();
    // The row claims org A - which this caller owns - while its endpoint belongs
    // to B. Believing the cheap column would hand B's delivery to A.
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expectCode(
      resolve(
        resolver,
        IDS.ownerA,
        { deliveryId: IDS.deliveryCorrupt },
        anchor('delivery', 'deliveryId'),
      ),
      'not_found',
    );
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('refuses another tenant event', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(resolver, IDS.ownerA, { eventId: IDS.eventB1 }, anchor('event', 'eventId')),
      'not_found',
    );
  });

  it('cross-checks a nested :orgId against the anchor, so a valid path cannot carry a foreign id', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(
        resolver,
        IDS.ownerA,
        { orgId: IDS.orgA, endpointId: IDS.endpointB1 },
        anchor('endpoint', 'endpointId'),
      ),
      'not_found',
    );
  });

  it('fails loudly when the declared anchor parameter is not on the route', async () => {
    const { resolver } = build();
    await expectCode(
      resolve(resolver, IDS.ownerA, { somethingElse: 'x' }, anchor('endpoint', 'endpointId')),
      'internal_error',
    );
  });

  it('resolves an organization anchor without a project', async () => {
    const { resolver } = build();
    const context = await resolve(
      resolver,
      IDS.viewerA,
      { organization: IDS.orgA },
      anchor('organization', 'organization'),
    );
    expect(context.project).toBeNull();
    expect(context.role).toBe('viewer');
  });
});

/**
 * THE EXISTENCE ORACLE.
 *
 * The status code was always 404, but the MESSAGE was not: `AppError.message`
 * is serialised verbatim into the body, an id that missed everywhere answered
 * "Endpoint not found." and an id that hit inside a FOREIGN tenant fell through
 * to the membership check and answered "Organization not found.". Two
 * distinguishable answers is a working oracle - scrape ids from old dashboard
 * URLs, support tickets or log exports and learn which are live infrastructure
 * belonging to another customer.
 *
 * This table is every anchor kind crossed with {absent, foreign}, asserting one
 * identical string. It fails if anyone reintroduces a per-resource message.
 */
describe('TenantResolver - absent and foreign are indistinguishable on the wire', () => {
  interface OracleCase {
    kind: TenantAnchorKind;
    param: string;
    /** An id that exists, inside organization B. */
    foreign: string;
    /** An id that exists nowhere. */
    absent: string;
  }

  const FOREIGN_KEY = 'key_b1';
  const FOREIGN_SUBSCRIPTION = 'sub_b1';

  function buildWithEveryAnchor(): TenantResolver {
    const db = seedWorld();
    db.insert('apiKey', { id: FOREIGN_KEY, projectId: IDS.projectB1, name: 'b key' });
    db.insert('webhookSubscription', {
      id: FOREIGN_SUBSCRIPTION,
      projectId: IDS.projectB1,
      endpointId: IDS.endpointB1,
      name: 'b sub',
    });
    return new TenantResolver(db.asPrisma());
  }

  const CASES: OracleCase[] = [
    { kind: 'organization', param: 'organization', foreign: IDS.orgB, absent: 'org_nope' },
    { kind: 'project', param: 'projectId', foreign: IDS.projectB1, absent: 'proj_nope' },
    { kind: 'endpoint', param: 'endpointId', foreign: IDS.endpointB1, absent: 'ep_nope' },
    { kind: 'subscription', param: 'subId', foreign: FOREIGN_SUBSCRIPTION, absent: 'sub_nope' },
    { kind: 'apiKey', param: 'keyId', foreign: FOREIGN_KEY, absent: 'key_nope' },
    { kind: 'event', param: 'eventId', foreign: IDS.eventB1, absent: 'evt_nope' },
    { kind: 'delivery', param: 'deliveryId', foreign: IDS.deliveryB1, absent: 'del_nope' },
  ];

  /** Every message the layer can produce for "you cannot have this". */
  async function messagesFor(outcome: 'foreign' | 'absent'): Promise<string[]> {
    const resolver = buildWithEveryAnchor();
    const messages: string[] = [];
    for (const testCase of CASES) {
      const error = await expectCode(
        resolve(
          resolver,
          IDS.ownerA,
          { [testCase.param]: testCase[outcome] },
          { from: 'anchor', kind: testCase.kind, param: testCase.param },
        ),
        'not_found',
      );
      messages.push(error.message);
    }
    // The default (route-parameter) path too - the one path the old suite
    // covered, and the only one where the two messages already agreed.
    const params: Record<string, string> =
      outcome === 'foreign' ? { orgId: IDS.orgB } : { orgId: 'org_nope' };
    messages.push((await expectCode(resolve(resolver, IDS.ownerA, params), 'not_found')).message);
    const nested: Record<string, string> =
      outcome === 'foreign'
        ? { orgId: IDS.orgA, projectId: IDS.projectB1 }
        : { orgId: IDS.orgA, projectId: 'proj_nope' };
    messages.push((await expectCode(resolve(resolver, IDS.ownerA, nested), 'not_found')).message);
    return messages;
  }

  it('answers one identical string for every anchor kind, absent or foreign', async () => {
    const all = [...(await messagesFor('absent')), ...(await messagesFor('foreign'))];
    expect(all).toHaveLength((CASES.length + 2) * 2);
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBe(CROSS_TENANT_MESSAGE);
  });

  it('names no resource type in the client-facing message', async () => {
    for (const message of await messagesFor('foreign')) {
      expect(message.toLowerCase()).not.toMatch(
        /endpoint|organization|project|event|delivery|subscription|api key/,
      );
    }
  });

  it('still records the specific reason for the operator, at debug level only', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const resolver = buildWithEveryAnchor();
    await expectCode(
      resolve(
        resolver,
        IDS.ownerA,
        { endpointId: IDS.endpointB1 },
        { from: 'anchor', kind: 'endpoint', param: 'endpointId' },
      ),
      'not_found',
    );
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(IDS.orgB));
    debug.mockRestore();
  });
});
