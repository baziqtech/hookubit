import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_SCOPES } from '../../types/api';
import {
  RATE_LIMIT_ENFORCEMENT,
  describeResource,
  enforcementVerdict,
  formatRate,
  rateLimitCoherenceIssues,
} from './rate-limit-rules';

describe('rateLimitCoherenceIssues', () => {
  it('accepts burst null — "the same as limit"', () => {
    expect(rateLimitCoherenceIssues({ limit: 100, window_seconds: 1, burst: null })).toEqual([]);
  });

  it('accepts burst equal to or above limit', () => {
    expect(rateLimitCoherenceIssues({ limit: 100, window_seconds: 1, burst: 100 })).toEqual([]);
    expect(rateLimitCoherenceIssues({ limit: 100, window_seconds: 1, burst: 250 })).toEqual([]);
  });

  it('refuses burst below limit, naming burst — the bucket could never reach the limit', () => {
    const issues = rateLimitCoherenceIssues({ limit: 100, window_seconds: 1, burst: 50 });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('burst');
    expect(issues[0].reason).toContain('must be at least limit');
  });
});

/**
 * The verdicts are read from the data plane, not from the DTO. If someone
 * wires `ResolveDelivery` into the worker, this table must change WITH the
 * code — and until then, no scope may claim delivery enforcement.
 */
describe('RATE_LIMIT_ENFORCEMENT', () => {
  it('covers every scope the schema declares', () => {
    for (const scope of RATE_LIMIT_SCOPES) {
      expect(RATE_LIMIT_ENFORCEMENT).toHaveProperty(scope);
    }
  });

  it('records that NO scope is enforced on the delivery path today', () => {
    // internal/worker/deliver.go:173 charges endpoints.rate_limit and nothing
    // else; internal/ratelimit/policy.go:161 — "Nothing wires this yet".
    for (const scope of RATE_LIMIT_SCOPES) {
      expect(RATE_LIMIT_ENFORCEMENT[scope].delivery).toBe(false);
    }
  });

  it('records that ingest, project and organization rows are charged on ingest', () => {
    // internal/ratelimit/policy.go:139-154, ResolveIngest.
    expect(RATE_LIMIT_ENFORCEMENT.ingest.ingest).toBe(true);
    expect(RATE_LIMIT_ENFORCEMENT.project.ingest).toBe(true);
    expect(RATE_LIMIT_ENFORCEMENT.organization.ingest).toBe(true);
  });

  it('records that endpoint-scope rows are read by nothing', () => {
    expect(RATE_LIMIT_ENFORCEMENT.endpoint).toEqual({ ingest: false, delivery: false });
  });

  it('gives only ingest scope the unqualified "enforced" badge', () => {
    expect(enforcementVerdict('ingest').kind).toBe('enforced');
    expect(enforcementVerdict('project').kind).toBe('partial');
    expect(enforcementVerdict('organization').kind).toBe('partial');
    expect(enforcementVerdict('endpoint').kind).toBe('inert');
    // The label must never READ as a promise the delivery path does not keep:
    // "Not enforced" is fine, "Enforced …" is not.
    expect(enforcementVerdict('endpoint').label).not.toMatch(/^enforced/i);
    expect(enforcementVerdict('project').label).not.toMatch(/^enforced/i);
  });
});

describe('describeResource', () => {
  const lookup = {
    endpoints: [{ id: 'ep_1', name: 'finance-api' }],
    apiKeys: [{ id: 'key_1', name: 'payment-gateway' }],
  };

  it('names the every-resource row per scope', () => {
    expect(describeResource({ scope: 'endpoint', resource_id: null }, lookup).label).toContain(
      'Every endpoint',
    );
    expect(describeResource({ scope: 'ingest', resource_id: null }, lookup).label).toContain(
      'Every API key',
    );
    expect(describeResource({ scope: 'project', resource_id: null }, lookup).label).toBe(
      'This project',
    );
    expect(describeResource({ scope: 'organization', resource_id: null }, lookup).label).toBe(
      'This organization',
    );
  });

  it('joins endpoint and API-key ids against the loaded lists', () => {
    expect(describeResource({ scope: 'endpoint', resource_id: 'ep_1' }, lookup)).toEqual({
      label: 'finance-api',
      unresolved: false,
    });
    expect(describeResource({ scope: 'ingest', resource_id: 'key_1' }, lookup)).toEqual({
      label: 'payment-gateway',
      unresolved: false,
    });
  });

  it('keeps an id that is not on the loaded page, flagged, rather than dropping it', () => {
    expect(describeResource({ scope: 'endpoint', resource_id: 'ep_9' }, lookup)).toEqual({
      label: 'ep_9',
      unresolved: true,
    });
  });

  it('calls a project- or organization-scoped id "this", because it can only be its own', () => {
    expect(describeResource({ scope: 'project', resource_id: 'proj_x' }, lookup).label).toBe(
      'This project',
    );
  });
});

describe('formatRate', () => {
  it('reads as limit per window in the cleanest unit', () => {
    expect(formatRate(100, 1)).toBe('100 / 1s');
    expect(formatRate(6_000, 60)).toBe('6,000 / 1m');
    expect(formatRate(10, 3_600)).toBe('10 / 1h');
    expect(formatRate(5, 90)).toBe('5 / 90s');
  });
});
