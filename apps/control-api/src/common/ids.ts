import { ulid } from 'ulid';

/**
 * Prefixed, lexicographically sortable identifiers (ARCHITECTURE.md 13).
 * The Go data plane generates the same shape; see internal/ids.
 */
export const ID_PREFIX = {
  organization: 'org',
  user: 'usr',
  member: 'mem',
  project: 'proj',
  apiKey: 'key',
  endpoint: 'ep',
  endpointSecret: 'eps',
  subscription: 'sub',
  retryPolicy: 'rp',
  rateLimitPolicy: 'rl',
  event: 'evt',
  outbox: 'obx',
  idempotency: 'idm',
  delivery: 'del',
  attempt: 'att',
  auditLog: 'aud',
  usage: 'usg',
  plan: 'plan',
  billing: 'bsub',
  token: 'tok',
  session: 'ses',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid()}`;
}
