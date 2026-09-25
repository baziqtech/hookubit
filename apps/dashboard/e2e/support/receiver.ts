import { createHmac, timingSafeEqual } from 'node:crypto';
import { expect } from '@playwright/test';
import { RECEIVER_PORT } from '../../playwright.config';

const BASE = `http://127.0.0.1:${RECEIVER_PORT}`;
/** The URL an endpoint is created with. Only routable because the dev stack allows private egress. */
export const RECEIVER_URL = `${BASE}/hooks/e2e`;

export interface ReceivedDelivery {
  at: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export async function resetReceiver(): Promise<void> {
  await fetch(`${BASE}/__reset`, { method: 'POST' });
}

export async function setReceiverMode(status: number): Promise<void> {
  await fetch(`${BASE}/__mode`, { method: 'POST', body: JSON.stringify({ status }) });
}

export async function received(): Promise<ReceivedDelivery[]> {
  const res = await fetch(`${BASE}/__received`);
  return (await res.json()) as ReceivedDelivery[];
}

/** Polls until at least `count` deliveries have arrived. */
export async function waitForDeliveries(count: number, timeout = 30_000): Promise<ReceivedDelivery[]> {
  await expect
    .poll(async () => (await received()).length, { timeout, message: `${count} deliveries at the receiver` })
    .toBeGreaterThanOrEqual(count);
  return received();
}

/**
 * Verifies `Webhook-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` the way the
 * integration guide tells consumers to: HMAC-SHA256 over `<t>.<raw body>`,
 * compared in constant time against ANY v1 value. `keyFor` is whatever the
 * platform's signing code does to a `whsec_…` secret before using it.
 */
export function verifySignature(delivery: ReceivedDelivery, secret: string, keyFor: (s: string) => Buffer): boolean {
  const header = delivery.headers['webhook-signature'];
  if (!header) return false;
  const parts = header.split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  if (!t) return false;
  const expected = createHmac('sha256', keyFor(secret)).update(`${t}.${delivery.body}`).digest();
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const given = Buffer.from(p.slice(3), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
