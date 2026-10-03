import { Attributes, Span } from '@opentelemetry/api';
import type { RequestContext, TenantRequest } from '../authz/tenant-context';
import {
  ATTR_WEBHOOK_MEMBER_ROLE,
  ATTR_WEBHOOK_ORGANIZATION_ID,
  ATTR_WEBHOOK_PROJECT_ID,
  ATTR_WEBHOOK_USER_ID,
  MAX_ATTRIBUTE_LENGTH,
  safeAttributeValue,
  setSafeAttribute,
  tenantAttributes,
} from './span-attributes';

function recordingSpan(): { span: Span; attributes: Attributes } {
  const attributes: Attributes = {};
  const span = {
    setAttribute(key: string, value: Attributes[string]) {
      attributes[key] = value;
      return this as unknown as Span;
    },
  } as unknown as Span;
  return { span, attributes };
}

function requestWithTenant(context: Partial<RequestContext> | null): TenantRequest {
  return { tenantContext: context ?? undefined } as unknown as TenantRequest;
}

const CALLER_CONTEXT: Partial<RequestContext> = {
  organization: { id: 'org_own', name: 'Own', slug: 'own', status: 'active' },
  project: {
    id: 'prj_own',
    organizationId: 'org_own',
    name: 'Own',
    slug: 'own',
    environment: 'live',
    status: 'active',
  },
  role: 'admin',
  user: { userId: 'usr_1', email: 'a@example.com', sessionId: 'ses_1' },
} as Partial<RequestContext>;

describe('safeAttributeValue', () => {
  it('passes ordinary values through', () => {
    expect(safeAttributeValue('http.route', '/v1/projects/:projectId')).toBe(
      '/v1/projects/:projectId',
    );
    expect(safeAttributeValue('http.response.status_code', 204)).toBe(204);
    expect(safeAttributeValue('webhook.replayed', true)).toBe(true);
  });

  it.each([
    'endpoint.secret',
    'signing_key',
    'api_key',
    'http.request.header.authorization',
    'session_token',
    'password',
    'x-api-key',
    'secret_value',
  ])('REFUSES the credential-shaped key %j', (key) => {
    expect(safeAttributeValue(key, 'whsec_live_do_not_log_me')).toBeUndefined();
  });

  it('still allows the metadata keys the audit rule deliberately keeps readable', () => {
    expect(safeAttributeValue('endpoint_secret_id', 'es_1')).toBe('es_1');
    expect(safeAttributeValue('secret_version', 3)).toBe(3);
    expect(safeAttributeValue('previous_secrets_expire_at', '2026-01-01')).toBe('2026-01-01');
  });

  it('drops null, undefined, blank strings and non-finite numbers', () => {
    expect(safeAttributeValue('a.b', null)).toBeUndefined();
    expect(safeAttributeValue('a.b', undefined)).toBeUndefined();
    expect(safeAttributeValue('a.b', '   ')).toBeUndefined();
    expect(safeAttributeValue('a.b', Number.NaN)).toBeUndefined();
    expect(safeAttributeValue('a.b', Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('drops values that are not primitives rather than serialising them', () => {
    expect(safeAttributeValue('a.b', { secret: 'x' })).toBeUndefined();
    expect(safeAttributeValue('a.b', ['x'])).toBeUndefined();
  });

  it('truncates a long value so one header cannot blow up a span', () => {
    const value = safeAttributeValue('user_agent.original', 'x'.repeat(5_000));
    expect(typeof value).toBe('string');
    expect((value as string).length).toBe(MAX_ATTRIBUTE_LENGTH);
    expect((value as string).endsWith('…')).toBe(true);
  });
});

describe('setSafeAttribute', () => {
  it('sets a permitted attribute', () => {
    const { span, attributes } = recordingSpan();
    setSafeAttribute(span, 'webhook.request_id', 'req_1');
    expect(attributes).toEqual({ 'webhook.request_id': 'req_1' });
  });

  it('sets NOTHING for a refused one - not the key, not a placeholder', () => {
    const { span, attributes } = recordingSpan();
    setSafeAttribute(span, 'endpoint.secret', 'whsec_live');
    setSafeAttribute(span, 'webhook.request_id', undefined);
    expect(attributes).toEqual({});
  });
});

describe('tenantAttributes', () => {
  it('is empty when the guard never resolved a tenant', () => {
    expect(tenantAttributes(requestWithTenant(null))).toEqual({});
  });

  it('records the tenant the guard PROVED the caller belongs to', () => {
    expect(tenantAttributes(requestWithTenant(CALLER_CONTEXT))).toEqual({
      [ATTR_WEBHOOK_ORGANIZATION_ID]: 'org_own',
      [ATTR_WEBHOOK_PROJECT_ID]: 'prj_own',
      [ATTR_WEBHOOK_MEMBER_ROLE]: 'admin',
      [ATTR_WEBHOOK_USER_ID]: 'usr_1',
    });
  });

  it('omits the project on an organization-level route rather than inventing one', () => {
    const attributes = tenantAttributes(
      requestWithTenant({ ...CALLER_CONTEXT, project: null }),
    );
    expect(attributes[ATTR_WEBHOOK_PROJECT_ID]).toBeUndefined();
    expect(attributes[ATTR_WEBHOOK_ORGANIZATION_ID]).toBe('org_own');
  });

  /**
   * The multi-tenant isolation property, asserted at the span layer.
   *
   * `TenantGuard` throws out of the resolver on a cross-tenant id and never
   * assigns `tenantContext`, so a refused request reaches here looking exactly
   * like an unauthenticated one. Reading `req.params.projectId` instead would
   * have written the other tenant's id onto the span - and the opaque
   * `Resource not found.` would have been undone in the trace backend.
   */
  it('records NOTHING about the tenant a refused cross-tenant request named', () => {
    const refused = {
      params: { orgId: 'org_someone_else', projectId: 'prj_someone_else' },
      // tenantContext deliberately absent: the resolver threw.
    } as unknown as TenantRequest;

    const attributes = tenantAttributes(refused);
    expect(attributes).toEqual({});
    expect(JSON.stringify(attributes)).not.toContain('someone_else');
  });

  it('never leaks the email address that sits next to the user id', () => {
    const attributes = tenantAttributes(requestWithTenant(CALLER_CONTEXT));
    expect(JSON.stringify(attributes)).not.toContain('@example.com');
  });
});
