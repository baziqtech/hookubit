import { describe, expect, it } from 'vitest';
import { API_KEY_PLACEHOLDER, buildPublishCurl } from './publish-request';

const PROJECT = 'proj_01JQPAYPROD';
const BASE = 'https://ingest.example.com';

describe('the first-event curl', () => {
  it('carries the operator’s REAL project id, not a placeholder', () => {
    const snippet = buildPublishCurl({ projectId: PROJECT, baseUrl: BASE });

    expect(snippet).toContain(`${BASE}/v1/projects/${PROJECT}/events`);
    expect(snippet).not.toMatch(/<your[-_ ]project/i);
    expect(snippet).not.toContain('{project_id}');
  });

  it('posts to the INGEST surface, never to the control API', () => {
    // Ingest is Go on :8080; the control API is NestJS on :3000. Publishing to
    // the latter 404s in a way that looks like it reached something.
    const snippet = buildPublishCurl({ projectId: PROJECT, baseUrl: BASE });
    expect(snippet).toMatch(/^curl -X POST/);
    expect(snippet).toContain('/v1/projects/');
    expect(snippet).toContain('/events');
  });

  it('leaves the key as a visible placeholder when none was pasted', () => {
    const snippet = buildPublishCurl({ projectId: PROJECT, baseUrl: BASE });
    expect(snippet).toContain(`Authorization: Bearer ${API_KEY_PLACEHOLDER}`);
  });

  it('substitutes a pasted key, trimming whitespace from the paste', () => {
    const snippet = buildPublishCurl({
      projectId: PROJECT,
      apiKey: '  wk_live_9f2cRealKey  ',
      baseUrl: BASE,
    });

    expect(snippet).toContain('Authorization: Bearer wk_live_9f2cRealKey');
    expect(snippet).not.toContain(API_KEY_PLACEHOLDER);
  });

  it('falls back to the placeholder for a blank paste rather than an empty header', () => {
    const snippet = buildPublishCurl({ projectId: PROJECT, apiKey: '   ', baseUrl: BASE });
    expect(snippet).toContain(`Bearer ${API_KEY_PLACEHOLDER}`);
    expect(snippet).not.toContain('Bearer "');
  });

  it('teaches Idempotency-Key, because the first request someone copies is the one they ship', () => {
    expect(buildPublishCurl({ projectId: PROJECT, baseUrl: BASE })).toContain('Idempotency-Key:');
  });

  it('sends a body with event_type and data, matching the ingest contract', () => {
    const snippet = buildPublishCurl({ projectId: PROJECT, baseUrl: BASE });
    expect(snippet).toContain('"event_type"');
    expect(snippet).toContain('"data"');
    expect(snippet).toContain('Content-Type: application/json');
  });
});
