import { SessionUser } from '../../auth/session.service';
import { TenantRequest } from '../tenant-context';
import { FakeTenantPrisma } from './tenant-prisma.fake';

/**
 * Two complete tenants side by side, plus a suspended one.
 *
 * Every isolation test in this suite is some form of "actor from A asks for the
 * B-shaped row", so the fixture always seeds a matching pair: the test that
 * proves a query returns A's endpoint is only meaningful if B's endpoint was
 * sitting in the same table and did not come back.
 */
export const IDS = {
  orgA: 'org_a',
  orgB: 'org_b',
  orgSuspended: 'org_s',

  ownerA: 'usr_owner_a',
  adminA: 'usr_admin_a',
  developerA: 'usr_dev_a',
  viewerA: 'usr_viewer_a',
  billingA: 'usr_billing_a',
  ownerB: 'usr_owner_b',
  ownerSuspended: 'usr_owner_s',
  stranger: 'usr_stranger',

  projectA1: 'proj_a1',
  projectA2: 'proj_a2',
  projectADeleted: 'proj_a_deleted',
  projectASuspended: 'proj_a_suspended',
  projectB1: 'proj_b1',
  projectS1: 'proj_s1',

  endpointA1: 'ep_a1',
  endpointB1: 'ep_b1',
  secretA1: 'eps_a1',
  secretB1: 'eps_b1',
  eventA1: 'evt_a1',
  eventB1: 'evt_b1',
  deliveryA1: 'del_a1',
  deliveryB1: 'del_b1',
  /** organization_id/project_id disagree with the endpoint ownership chain. */
  deliveryCorrupt: 'del_corrupt',
  attemptA1: 'att_a1',
  attemptB1: 'att_b1',
  /** Hangs off del_corrupt, so the same disagreement is reachable one hop down. */
  attemptCorrupt: 'att_corrupt',
  retryPolicyA1: 'rp_a1',
  retryPolicyB1: 'rp_b1',
  subscriptionA1: 'sub_a1',
} as const;

export function seedWorld(): FakeTenantPrisma {
  const db = new FakeTenantPrisma();

  db.insert('organization', { id: IDS.orgA, name: 'Acme', slug: 'acme', status: 'active' });
  db.insert('organization', { id: IDS.orgB, name: 'Globex', slug: 'globex', status: 'active' });
  db.insert('organization', {
    id: IDS.orgSuspended,
    name: 'Initech',
    slug: 'initech',
    status: 'suspended',
  });

  for (const id of [
    IDS.ownerA,
    IDS.adminA,
    IDS.developerA,
    IDS.viewerA,
    IDS.billingA,
    IDS.ownerB,
    IDS.ownerSuspended,
    IDS.stranger,
  ]) {
    db.insert('user', { id, email: `${id}@example.com`, disabledAt: null });
  }

  const member = (organizationId: string, userId: string, role: string): void => {
    db.insert('organizationMember', {
      id: `mem_${userId}_${organizationId}`,
      organizationId,
      userId,
      role,
    });
  };
  member(IDS.orgA, IDS.ownerA, 'owner');
  member(IDS.orgA, IDS.adminA, 'admin');
  member(IDS.orgA, IDS.developerA, 'developer');
  member(IDS.orgA, IDS.viewerA, 'viewer');
  member(IDS.orgA, IDS.billingA, 'billing');
  member(IDS.orgB, IDS.ownerB, 'owner');
  member(IDS.orgSuspended, IDS.ownerSuspended, 'owner');

  const project = (id: string, organizationId: string, status = 'active'): void => {
    db.insert('project', {
      id,
      organizationId,
      name: id,
      slug: id,
      environment: 'test',
      status,
    });
  };
  project(IDS.projectA1, IDS.orgA);
  project(IDS.projectA2, IDS.orgA);
  project(IDS.projectADeleted, IDS.orgA, 'deleted');
  project(IDS.projectASuspended, IDS.orgA, 'suspended');
  project(IDS.projectB1, IDS.orgB);
  project(IDS.projectS1, IDS.orgSuspended);

  db.insert('endpoint', {
    id: IDS.endpointA1,
    projectId: IDS.projectA1,
    name: 'a1',
    url: 'https://a.example.com/hook',
    status: 'active',
  });
  db.insert('endpoint', {
    id: IDS.endpointB1,
    projectId: IDS.projectB1,
    name: 'b1',
    url: 'https://b.example.com/hook',
    status: 'active',
  });

  db.insert('retryPolicy', {
    id: IDS.retryPolicyA1,
    projectId: IDS.projectA1,
    name: 'a1',
    maxAttempts: 8,
  });
  db.insert('retryPolicy', {
    id: IDS.retryPolicyB1,
    projectId: IDS.projectB1,
    name: 'b1',
    maxAttempts: 8,
  });

  db.insert('webhookSubscription', {
    id: IDS.subscriptionA1,
    projectId: IDS.projectA1,
    endpointId: IDS.endpointA1,
    eventTypes: ['*'],
    enabled: true,
  });

  // Circuit-breaker state is keyed by endpoint_id, not id.
  db.insert('endpointHealth', { endpointId: IDS.endpointA1, state: 'healthy' });
  db.insert('endpointHealth', { endpointId: IDS.endpointB1, state: 'open' });

  db.insert('endpointSecret', { id: IDS.secretA1, endpointId: IDS.endpointA1, version: 1 });
  db.insert('endpointSecret', { id: IDS.secretB1, endpointId: IDS.endpointB1, version: 1 });

  db.insert('event', {
    id: IDS.eventA1,
    organizationId: IDS.orgA,
    projectId: IDS.projectA1,
    eventType: 'order.created',
  });
  db.insert('event', {
    id: IDS.eventB1,
    organizationId: IDS.orgB,
    projectId: IDS.projectB1,
    eventType: 'order.created',
  });

  db.insert('delivery', {
    id: IDS.deliveryA1,
    eventId: IDS.eventA1,
    endpointId: IDS.endpointA1,
    organizationId: IDS.orgA,
    projectId: IDS.projectA1,
    status: 'pending',
  });
  db.insert('delivery', {
    id: IDS.deliveryB1,
    eventId: IDS.eventB1,
    endpointId: IDS.endpointB1,
    organizationId: IDS.orgB,
    projectId: IDS.projectB1,
    status: 'pending',
  });
  // The denormalised columns claim org A; the endpoint really belongs to B.
  db.insert('delivery', {
    id: IDS.deliveryCorrupt,
    eventId: IDS.eventB1,
    endpointId: IDS.endpointB1,
    organizationId: IDS.orgA,
    projectId: IDS.projectA1,
    status: 'pending',
  });

  db.insert('deliveryAttempt', {
    id: IDS.attemptA1,
    deliveryId: IDS.deliveryA1,
    attemptNumber: 1,
  });
  db.insert('deliveryAttempt', {
    id: IDS.attemptB1,
    deliveryId: IDS.deliveryB1,
    attemptNumber: 1,
  });
  db.insert('deliveryAttempt', {
    id: IDS.attemptCorrupt,
    deliveryId: IDS.deliveryCorrupt,
    attemptNumber: 1,
  });

  return db;
}

export function sessionUser(userId: string): SessionUser {
  return { userId, email: `${userId}@example.com`, sessionId: `ses_${userId}` };
}

/** A request object carrying only what TenantResolver reads. */
export function requestWith(params: Record<string, string>, userId?: string): TenantRequest {
  return {
    params,
    headers: { 'user-agent': 'jest' },
    ip: '203.0.113.9',
    sessionUser: userId ? sessionUser(userId) : undefined,
  } as unknown as TenantRequest;
}
