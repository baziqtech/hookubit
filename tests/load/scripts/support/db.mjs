/**
 * The two things a load run must do to the database before and after k6, and
 * neither of them is measurement.
 *
 * QUIESCENCE. Deliveries outlive the k6 process. A run that starts while the
 * previous run's backlog is still draining measures both of them at once, and
 * the numbers are worthless. So every run waits for its projects to go quiet
 * first - and a run that never goes quiet says so instead of pretending.
 *
 * BREAKER RESET. The circuit breaker is per endpoint and persists in
 * `endpoint_health`. An endpoint left open by the previous scenario is not
 * attempted at all in the next one, which reads as starvation and is not. These
 * rows belong to the load suite's own endpoints and the worker recreates them
 * on the next attempt, so deleting them is a reset, not a repair.
 */

import { prisma } from './api.mjs';

const NON_TERMINAL = ['pending', 'scheduled', 'queued', 'processing', 'retrying'];

export function endpointIds(manifest) {
  return manifest.projects.flatMap((p) => p.endpoints.map((e) => e.id));
}

export async function pendingDeliveries(manifest) {
  const db = prisma();
  const rows = await db.delivery.groupBy({
    by: ['status'],
    where: {
      projectId: { in: manifest.projects.map((p) => p.id) },
      status: { in: NON_TERMINAL },
    },
    _count: { _all: true },
  });
  return rows.reduce((n, r) => n + r._count._all, 0);
}

/**
 * Wait until nothing is left to deliver, or until the number stops falling.
 *
 * "Stops falling" is the important second condition. The failing-endpoint
 * scenario deliberately leaves rows parked behind an open breaker; those will
 * never reach zero inside a run, and waiting for zero would hang forever.
 */
export async function waitForQuiesce(manifest, { timeoutMs = 300000, stallMs = 20000, label = '' } = {}) {
  const startedAt = Date.now();
  let last = await pendingDeliveries(manifest);
  if (last === 0) return { quiet: true, remaining: 0, waitedMs: 0 };

  console.log(`  waiting for ${last} in-flight deliveries to drain${label ? ` (${label})` : ''}...`);
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await pendingDeliveries(manifest);
    if (now === 0) return { quiet: true, remaining: 0, waitedMs: Date.now() - startedAt };
    if (now !== last) {
      last = now;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt > stallMs) {
      return { quiet: false, remaining: now, waitedMs: Date.now() - startedAt, stalled: true };
    }
  }
  return { quiet: false, remaining: last, waitedMs: Date.now() - startedAt, timedOut: true };
}

/** Clear circuit-breaker state for this scenario's endpoints. */
export async function resetBreakers(manifest) {
  const db = prisma();
  const ids = endpointIds(manifest);
  if (ids.length === 0) return 0;
  const { count } = await db.endpointHealth.deleteMany({ where: { endpointId: { in: ids } } });
  return count;
}
