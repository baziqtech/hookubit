import { describe, expect, it } from 'vitest';
import { describeActor } from './api';
import type { AuditLogEntry } from '../../types/api';

const entry = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'aud_1',
  organization_id: 'org_1',
  user_id: null,
  api_key_id: null,
  action: 'endpoint.disabled',
  resource_type: 'endpoint',
  resource_id: 'ep_1',
  metadata: null,
  ip_address: null,
  user_agent: null,
  created_at: '2026-09-06T12:00:00.000Z',
  ...over,
});

/**
 * `AuditLogDto` has NO nested `actor` object — the dashboard rendered
 * `row.actor.email` and `row.actor.type`, and neither exists. The actor is one
 * of two nullable ids, and the third case is "neither", which is the platform
 * acting on its own.
 *
 * That third case is the important one on this page: an endpoint the circuit
 * breaker disabled has no user and no API key behind it, and rendering it as an
 * empty actor cell is how "nobody did this, the platform did" gets read as
 * missing data.
 */
describe('describeActor', () => {
  it('reads a user action off user_id', () => {
    expect(describeActor(entry({ user_id: 'usr_1' }))).toEqual({ kind: 'user', id: 'usr_1' });
  });

  it('reads a machine action off api_key_id', () => {
    expect(describeActor(entry({ api_key_id: 'key_1' }))).toEqual({
      kind: 'api_key',
      id: 'key_1',
    });
  });

  it('calls an action with neither id what it is: the platform', () => {
    expect(describeActor(entry({ action: 'endpoint.auto_disabled' }))).toEqual({
      kind: 'system',
      id: null,
    });
  });
});
