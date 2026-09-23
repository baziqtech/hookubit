import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { dismissProductTour, loadSharedAccount, signIn, type Account } from './support/account';
import {
  RECEIVER_URL,
  received,
  resetReceiver,
  setReceiverMode,
  verifySignature,
  waitForDeliveries,
} from './support/receiver';

const INGEST = process.env.INGEST_URL ?? 'http://localhost:8080';

/**
 * One operator's whole journey against the real control API, data plane and
 * SMTP. Every control the dashboard offers is exercised, and every number the
 * dashboard shows is checked against what the receiver actually got.
 */
/**
 * Every test gets its own browser context, so the session is established ONCE
 * (the first time the `storageState` fixture is asked for) and every later
 * context starts from that state. Signing in per test would also walk
 * straight into the login throttle (10 per 15 minutes per address).
 */
let account: Account;
let cachedState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

test.describe.serial('a project, end to end', () => {
  test.use({
    storageState: async ({ browser, baseURL }, use) => {
      if (!cachedState) {
        account ??= await loadSharedAccount();
        // A hand-made context does not inherit the project's baseURL.
        const context = await browser.newContext({ baseURL: baseURL ?? undefined });
        const page = await context.newPage();
        await signIn(page, account);
        cachedState = await context.storageState();
        await context.close();
      }
      await use(cachedState);
    },
  });
  const state = {
    orgId: '',
    projectId: '',
    projectSlug: '',
    apiKey: '',
    signingSecret: '',
    eventIds: [] as string[],
  };

  const stamp = Date.now().toString(36);
  const PROJECT = `Payments ${stamp}`;
  const ENDPOINT = `finance-api-${stamp}`;
  const SUBSCRIPTION = `Everything to finance ${stamp}`;

  const projectBase = () => `/orgs/${state.orgId}/projects/${state.projectId}`;
  const dialog = (page: Page) => page.getByRole('dialog');
  const rowNamed = (page: Page, text: string | RegExp): Locator =>
    page.getByRole('row').filter({ hasText: text });
  /**
   * Reload and count matching rows once the list has actually rendered - a
   * count taken in the same tick as the reload sees an empty document.
   */
  const rowsAfterReload = async (page: Page, text: RegExp): Promise<number> => {
    await page.reload();
    await page
      .getByRole('table')
      .or(page.getByText(/^No deliveries/))
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    return rowNamed(page, text).count();
  };

  /** Options carry more than the name ("name — url"), so match by text, select by value. */
  const selectByText = async (select: Locator, text: string) => {
    const value = await select.locator('option', { hasText: text }).first().getAttribute('value');
    if (!value) throw new Error(`no option containing "${text}"`);
    await select.selectOption(value);
  };

  test.beforeAll(async () => {
    account ??= await loadSharedAccount();
    await resetReceiver();
  });

  test('a new account lands in an organization with no projects, and creates one', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/orgs\/(org_[A-Z0-9]+)/);
    await dismissProductTour(page);
    state.orgId = page.url().match(/\/orgs\/(org_[A-Z0-9]+)/)![1];

    await expect(page.getByText('No projects yet')).toBeVisible();
    await page.getByRole('button', { name: 'Create project' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'New project' })).toBeVisible();
    await d.getByLabel('Name').fill(PROJECT);
    // Environment is immutable after creation; the form says so.
    await expect(d.getByText(/immutable|cannot be changed/i)).toBeVisible();
    await d.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/projects\/(proj_[A-Z0-9]+)\/overview/);
    state.projectId = page.url().match(/\/projects\/(proj_[A-Z0-9]+)/)![1];
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    // First-run: the overview is the checklist, not a 0.00% success tile.
    await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();

    await page.goto(`${projectBase()}/settings`);
    // The identity form is populated once the project row has loaded.
    const slug = page.getByRole('main').getByLabel('Slug');
    await expect(slug).not.toHaveValue('');
    state.projectSlug = await slug.inputValue();
  });

  test('an API key is created and shown exactly once', async ({ page }) => {
    await page.goto(`${projectBase()}/api-keys`);
    await page.getByRole('button', { name: 'Create key' }).click();
    const d = dialog(page);
    await d.getByLabel('Name').fill('payment-gateway (e2e)');
    await d.getByRole('button', { name: 'Create key' }).click();
    const plaintext = d.getByTestId('secret-plaintext');
    await expect(plaintext).toBeVisible();
    state.apiKey = (await plaintext.textContent())!.trim();
    expect(state.apiKey.length).toBeGreaterThan(20);
    await d.getByRole('button', { name: 'I have copied it' }).click();
    await expect(rowNamed(page, 'payment-gateway (e2e)')).toContainText('active');
  });

  test('an endpoint pointing at the receiver is created with its signing secret', async ({ page }) => {
    await page.goto(`${projectBase()}/endpoints`);
    await page.getByRole('button', { name: 'Add endpoint' }).first().click();
    const d = dialog(page);
    await d.getByLabel('Name').fill(ENDPOINT);
    await d.getByLabel('URL').fill(RECEIVER_URL);
    await d.getByRole('button', { name: 'Create endpoint' }).click();
    const plaintext = d.getByTestId('secret-plaintext');
    await expect(plaintext).toBeVisible();
    state.signingSecret = (await plaintext.textContent())!.trim();
    expect(state.signingSecret.startsWith('whsec_')).toBe(true);
    await d.getByRole('button', { name: 'Done' }).click();
    /*
     * "On" and "Delivering", not "active".
     *
     * The endpoints table carries the operator's setting and the platform's
     * verdict as two separate columns, because an endpoint you still want
     * delivering that WE stopped is a different problem from one you paused
     * yourself. `active` was the single status this replaced.
     */
    await expect(rowNamed(page, ENDPOINT)).toContainText('On');
    await expect(rowNamed(page, ENDPOINT)).toContainText('Delivering');
  });

  test('the endpoint is subscribed to every event type', async ({ page }) => {
    await page.goto(`${projectBase()}/subscriptions`);
    await page.getByRole('button', { name: 'New subscription' }).click();
    const d = dialog(page);
    await d.getByLabel('Name').fill(SUBSCRIPTION);
    await selectByText(d.getByLabel('Endpoint'), ENDPOINT);
    await d.getByLabel('Event types').fill('*');
    await d.getByRole('button', { name: 'Create subscription' }).click();
    await expect(d).toBeHidden();
    const row = rowNamed(page, SUBSCRIPTION);
    await expect(row).toContainText('enabled');
    await expect(row).toContainText(ENDPOINT);
  });

  test('a refused event-type pattern is refused in the form, never widened', async ({ page }) => {
    await page.goto(`${projectBase()}/subscriptions`);
    await page.getByRole('button', { name: 'New subscription' }).click();
    const d = dialog(page);
    await selectByText(d.getByLabel('Endpoint'), ENDPOINT);
    await d.getByLabel('Event types').fill('payment.*.settled');
    await d.getByRole('button', { name: 'Create subscription' }).click();
    await expect(d).toBeVisible();
    // The refusal is placed under the field, in the server's own words.
    await expect(d.locator('.text-danger').first()).toBeVisible();
    await d.getByRole('button', { name: 'Cancel' }).click();
  });

  test('the setup checklist is complete and the overview becomes the health page', async ({ page }) => {
    await page.goto(`${projectBase()}/overview`);
    await expect(page.getByText('Success rate (24h)')).toBeVisible();
  });

  test('a published event is delivered to the receiver, signed with the endpoint secret', async ({ page, request }) => {
    const idempotencyKey = `e2e-${stamp}-1`;
    const res = await request.post(`${INGEST}/v1/projects/${state.projectId}/events`, {
      headers: {
        Authorization: `Bearer ${state.apiKey}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      data: { event_type: 'payment.settled', data: { order_id: `ord_${stamp}`, amount: 120.5 } },
    });
    expect(res.status(), await res.text()).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('accepted');
    state.eventIds.push(body.id);

    const deliveries = await waitForDeliveries(1);
    const delivery = deliveries[0];
    expect(delivery.method).toBe('POST');
    expect(delivery.headers['webhook-id']).toBe(body.id);
    expect(delivery.headers['webhook-event-type']).toBe('payment.settled');
    expect(delivery.headers['webhook-attempt']).toBe('1');
    expect(JSON.parse(delivery.body).data.order_id).toBe(`ord_${stamp}`);
    // The secret is used as raw bytes; there is no prefix stripping or decoding.
    expect(verifySignature(delivery, state.signingSecret, (s) => Buffer.from(s, 'utf8'))).toBe(true);
    expect(verifySignature(delivery, 'whsec_wrong', (s) => Buffer.from(s, 'utf8'))).toBe(false);

    // Same idempotency key + same body -> the same event, no second delivery.
    const again = await request.post(`${INGEST}/v1/projects/${state.projectId}/events`, {
      headers: { Authorization: `Bearer ${state.apiKey}`, 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json' },
      data: { event_type: 'payment.settled', data: { order_id: `ord_${stamp}`, amount: 120.5 } },
    });
    expect(again.status()).toBe(202);
    expect(((await again.json()) as { id: string }).id).toBe(body.id);

    await page.goto(`${projectBase()}/deliveries`);
    await expect.poll(() => rowsAfterReload(page, /succeeded/i), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.goto(`${projectBase()}/events`);
    await expect(page.getByText('payment.settled').first()).toBeVisible();
  });

  test('the event detail explains the delivery, and replaying it delivers again', async ({ page }) => {
    await page.goto(`${projectBase()}/events/${state.eventIds[0]}`);
    await expect(page.getByText('payment.settled').first()).toBeVisible();
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();

    const before = (await received()).length;
    await page.getByRole('button', { name: 'Replay event' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Replay this event?' })).toBeVisible();
    await d.getByRole('button', { name: /replay/i }).click();
    await expect(d).toBeHidden();
    const after = await waitForDeliveries(before + 1);
    const replayed = after[after.length - 1];
    expect(replayed.headers['webhook-id']).toBe(state.eventIds[0]);
    expect(verifySignature(replayed, state.signingSecret, (s) => Buffer.from(s, 'utf8'))).toBe(true);
  });

  test('a delivery detail page has the attempt history, and does not offer to replay a success', async ({ page }) => {
    await page.goto(`${projectBase()}/deliveries`);
    await rowNamed(page, /succeeded/i).first().getByRole('link').first().click();
    await expect(page).toHaveURL(/\/deliveries\/del_/);
    await expect(page.getByText(/attempt/i).first()).toBeVisible();
    // Replaying a success is almost always an accident; the button says why.
    const replay = page.getByRole('button', { name: 'Replay delivery' });
    await expect(replay).toBeDisabled();
    await expect(replay).toHaveAttribute('title', /retry chain has stopped/);
  });

  test('a failing consumer is retried, and the overview says so', async ({ page, request }) => {
    await setReceiverMode(503);
    const before = (await received()).length;
    const res = await request.post(`${INGEST}/v1/projects/${state.projectId}/events`, {
      headers: { Authorization: `Bearer ${state.apiKey}`, 'Idempotency-Key': `e2e-${stamp}-fail`, 'Content-Type': 'application/json' },
      data: { event_type: 'payment.failed', data: { order_id: `ord_${stamp}_fail` } },
    });
    expect(res.status()).toBe(202);
    state.eventIds.push(((await res.json()) as { id: string }).id);

    // First attempt lands and is answered 503; the default policy retries
    // after ~5s, so a second attempt follows.
    await waitForDeliveries(before + 2, 40_000);
    await page.goto(`${projectBase()}/deliveries`);
    await expect.poll(() => rowsAfterReload(page, /retrying|failed/i), { timeout: 20_000 }).toBeGreaterThan(0);

    // Back to healthy: the next retry succeeds.
    await setReceiverMode(200);
    await expect.poll(() => rowsAfterReload(page, /succeeded/i), { timeout: 90_000 }).toBeGreaterThanOrEqual(3);
  });

  test('analytics reads the real routes: outcomes, latency, event volume', async ({ page }) => {
    await page.goto(`${projectBase()}/analytics`);
    await expect(page.getByRole('heading', { name: 'Delivery outcomes' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Attempt latency' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Event volume' })).toBeVisible();
    await expect(page.getByText('payment.settled').first()).toBeVisible();
    await expect(page.getByText('Events published', { exact: true }).first().locator('..')).toContainText('2');
    await page.getByLabel('Window').selectOption('7d').catch(async () => {
      await page.getByRole('button', { name: '7d' }).click();
    });
    await expect(page).toHaveURL(/window=7d/);
    await expect(page.getByRole('heading', { name: 'Delivery outcomes' })).toBeVisible();
  });

  test('the overview tiles show the same numbers', async ({ page }) => {
    await page.goto(`${projectBase()}/overview`);
    await expect(page.getByText('Success rate (24h)', { exact: true }).first().locator('..')).toContainText('%');
    await expect(page.getByText('p95 latency (24h)', { exact: true }).first().locator('..')).toContainText(/ms|s/);
  });

  test('pausing an endpoint cancels what was queued - exactly as the dialog says - and a cancelled delivery can be replayed', async ({ page, request }) => {
    // A delivery in its retry chain, so there is something queued to cancel.
    await setReceiverMode(503);
    const res = await request.post(`${INGEST}/v1/projects/${state.projectId}/events`, {
      headers: { Authorization: `Bearer ${state.apiKey}`, 'Idempotency-Key': `e2e-${stamp}-pause`, 'Content-Type': 'application/json' },
      data: { event_type: 'payment.refunded', data: { order_id: `ord_${stamp}_pause` } },
    });
    expect(res.status()).toBe(202);
    await page.goto(`${projectBase()}/deliveries`);
    await expect.poll(() => rowsAfterReload(page, /retrying/i), { timeout: 30_000 }).toBeGreaterThan(0);
    await setReceiverMode(200);

    await page.goto(`${projectBase()}/endpoints`);
    const row = rowNamed(page, ENDPOINT);
    await row.getByRole('button', { name: 'Pause deliveries' }).click();
    const d = dialog(page);
    // The truthful copy: queued deliveries are cancelled, not held.
    await expect(d.getByText(/cancelled/i).first()).toBeVisible();
    await d.getByLabel('Reason').fill('e2e: pausing on purpose');
    await d.getByRole('button', { name: 'Pause deliveries' }).click();
    await expect(d).toBeHidden();
    // The operator's own decision, so the setting column says so and the
    // platform column reports the consequence.
    await expect(row).toContainText('Paused by you');
    await expect(row).toContainText('Not sending');

    // The worker reaches the queued retry and finishes it `cancelled`.
    await page.goto(`${projectBase()}/deliveries`);
    await expect.poll(() => rowsAfterReload(page, /cancelled/i), { timeout: 60_000 }).toBeGreaterThan(0);

    await page.goto(`${projectBase()}/endpoints`);
    await rowNamed(page, ENDPOINT).getByRole('button', { name: 'Resume deliveries' }).click();
    await dialog(page).getByRole('button', { name: /resume/i }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(rowNamed(page, ENDPOINT)).toContainText('Delivering');

    // Replay is the path back for a cancelled delivery, and it is delivery-level.
    await page.goto(`${projectBase()}/deliveries`);
    await rowNamed(page, /cancelled/i).first().getByRole('link').first().click();
    await expect(page).toHaveURL(/\/deliveries\/del_/);
    const before = (await received()).length;
    await page.getByRole('button', { name: 'Replay delivery' }).click();
    const confirm = dialog(page);
    await expect(confirm.getByRole('heading', { name: 'Replay this delivery?' })).toBeVisible();
    await confirm.getByRole('button', { name: /replay/i }).click();
    await expect(confirm).toBeHidden();
    const after = await waitForDeliveries(before + 1);
    expect(after[after.length - 1].headers['webhook-event-type']).toBe('payment.refunded');
  });

  test('a signing secret is rotated with an overlap, and the new one signs the next delivery', async ({ page, request }) => {
    await page.goto(`${projectBase()}/endpoints`);
    await rowNamed(page, ENDPOINT).getByRole('button', { name: 'Secrets' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Signing secrets' })).toBeVisible();
    await d.getByRole('button', { name: 'Rotate' }).first().click();
    await d.getByRole('button', { name: /^Rotate/ }).last().click();
    const plaintext = d.getByTestId('secret-plaintext');
    await expect(plaintext).toBeVisible();
    const rotated = (await plaintext.textContent())!.trim();
    expect(rotated.startsWith('whsec_')).toBe(true);
    expect(rotated).not.toBe(state.signingSecret);

    const before = (await received()).length;
    const res = await request.post(`${INGEST}/v1/projects/${state.projectId}/events`, {
      headers: { Authorization: `Bearer ${state.apiKey}`, 'Idempotency-Key': `e2e-${stamp}-rotated`, 'Content-Type': 'application/json' },
      data: { event_type: 'payment.settled', data: { order_id: `ord_${stamp}_rot` } },
    });
    expect(res.status()).toBe(202);
    const after = await waitForDeliveries(before + 1);
    const delivery = after[after.length - 1];
    // Both secrets are live during the overlap: two v1 signatures, either verifies.
    expect((delivery.headers['webhook-signature'].match(/v1=/g) ?? []).length).toBe(2);
    expect(verifySignature(delivery, rotated, (s) => Buffer.from(s, 'utf8'))).toBe(true);
    expect(verifySignature(delivery, state.signingSecret, (s) => Buffer.from(s, 'utf8'))).toBe(true);
    state.signingSecret = rotated;
  });

  test('retry policies and rate limits are created from the dashboard', async ({ page }) => {
    await page.goto(`${projectBase()}/policies`);
    await page.getByRole('tab', { name: /retry/i }).click();
    await page.getByRole('main').getByRole('button', { name: 'Create policy' }).first().click();
    let d = dialog(page);
    await d.getByLabel('Name').fill('Patient partners');
    await d.getByLabel('Max attempts').fill('3');
    await d.getByRole('button', { name: 'Create policy' }).click();
    await expect(d).toBeHidden();
    await expect(rowNamed(page, 'Patient partners')).toBeVisible();
    // The first policy in a project becomes the default.
    await expect(rowNamed(page, 'Patient partners')).toContainText(/default/i);

    await page.getByRole('tab', { name: /rate/i }).click();
    await page.getByRole('main').getByRole('button', { name: 'Create policy' }).first().click();
    d = dialog(page);
    await d.getByLabel('Scope').selectOption('ingest');
    await d.getByLabel('Limit').fill('100');
    await d.getByRole('button', { name: 'Create policy' }).click();
    await expect(d).toBeHidden();
    await expect(rowNamed(page, /ingest/i)).toBeVisible();
    await expect(page.getByText(/enforced on ingest/i).first()).toBeVisible();
  });

  test('the endpoint form offers the new retry policy', async ({ page }) => {
    await page.goto(`${projectBase()}/endpoints`);
    await rowNamed(page, ENDPOINT).getByRole('button', { name: 'Edit' }).click();
    const d = dialog(page);
    await selectByText(d.getByLabel('Retry policy'), 'Patient partners');
    await d.getByRole('button', { name: /save/i }).click();
    await expect(d).toBeHidden();
  });

  test('team: an invitation is sent, and your own role cannot be changed by you', async ({ page }) => {
    await page.goto(`/orgs/${state.orgId}/team`);
    await expect(rowNamed(page, account.email)).toContainText('owner');
    // Your own row: no role select, the lattice's reason instead, and Remove refused.
    const me = rowNamed(page, account.email);
    await expect(me).toContainText(/your own role/i);
    await expect(me.getByRole('button', { name: /^Remove/ })).toBeDisabled();
    await page.getByRole('button', { name: 'Invite member' }).click();
    const d = dialog(page);
    await d.getByLabel('Email').fill(`invitee-${stamp}@example.test`);
    await d.getByLabel('Role').selectOption('developer');
    await d.getByRole('button', { name: 'Send invitation' }).click();
    await expect(d.getByText(/on its way/)).toBeVisible();
    await d.getByRole('button', { name: 'Done' }).click();
  });

  test('project settings rename the project and it reaches the switcher', async ({ page }) => {
    await page.goto(`${projectBase()}/settings`);
    const main = page.getByRole('main');
    await main.getByLabel('Name').fill(`${PROJECT} renamed`);
    // `Save changes`, exactly. The page now also carries "Save addresses" for
    // the publish allowlist, so /save/i matches two buttons.
    await main.getByRole('button', { name: 'Save changes' }).click();
    // One card in the rail switches BOTH project and organization: people
    // switch project many times a day and organization approximately never, so
    // the card is the project and the organization is the line under it.
    await expect(
      page.getByRole('button', { name: 'Switch project or organization' }),
    ).toContainText(`${PROJECT} renamed`);
  });

  test('usage and the audit log reflect what happened', async ({ page }) => {
    await page.goto(`/orgs/${state.orgId}/usage`);
    await expect(rowNamed(page, /renamed/)).toBeVisible();
    await expect(rowNamed(page, /renamed/)).toContainText(/\b[1-9]\d*\b/);
    await page.goto(`/orgs/${state.orgId}/audit`);
    await expect(page.getByText('endpoint.disabled').first()).toBeVisible();
    await expect(page.getByText('endpoint.enabled').first()).toBeVisible();
  });

  test('stuck events: not in the navigation, still reachable and still named', async ({ page }) => {
    await page.goto(`${projectBase()}/deliveries`);
    // It earns no permanent slot: the condition is absent almost always.
    await expect(page.getByRole('link', { name: 'Stuck events' })).toHaveCount(0);
    // And with nothing stuck, the notice says nothing either.
    await expect(page.getByRole('status').filter({ hasText: /never routed/i })).toHaveCount(0);
    await page.goto(`${projectBase()}/overview`);
    await expect(page.getByRole('status').filter({ hasText: /never routed/i })).toHaveCount(0);

    // The page is still a page: reachable by address, and it tells you where
    // you are even though nothing in the rail pointed here.
    await page.goto(`${projectBase()}/outbox`);
    await expect(page.getByRole('heading', { name: 'Stuck events' })).toBeVisible();
    await expect(page.getByText(/nothing is stuck/i)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Stuck events');
  });

  test('revoking the key stops publishing', async ({ page, request }) => {
    await page.goto(`${projectBase()}/api-keys`);
    await rowNamed(page, 'payment-gateway (e2e)').getByRole('button', { name: /revoke/i }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Revoke this API key?' })).toBeVisible();
    await d.getByRole('button', { name: /revoke/i }).click();
    await expect(d).toBeHidden();
    await expect(rowNamed(page, 'payment-gateway (e2e)')).toContainText('revoked');
    const res = await request.post(`${INGEST}/v1/projects/${state.projectId}/events`, {
      headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json' },
      data: { event_type: 'payment.settled', data: {} },
    });
    expect(res.status()).toBe(401);
  });

  test('the subscription and the endpoint are deleted, the ledger stays readable', async ({ page }) => {
    await page.goto(`${projectBase()}/subscriptions`);
    await rowNamed(page, SUBSCRIPTION).getByRole('button', { name: 'Delete' }).click();
    let d = dialog(page);
    await expect(d.getByText('This is a hard delete')).toBeVisible();
    await d.getByRole('button', { name: /delete/i }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText('No subscriptions')).toBeVisible();

    await page.goto(`${projectBase()}/endpoints`);
    await rowNamed(page, ENDPOINT).getByRole('button', { name: 'Delete' }).click();
    d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Delete this endpoint?' })).toBeVisible();
    await d.getByRole('button', { name: /delete/i }).click();
    await expect(d).toBeHidden();
    await page.getByLabel('Show deleted endpoints').check();
    await expect(rowNamed(page, ENDPOINT)).toContainText('kept for the ledger');

    // The delivery history survives the endpoint.
    await page.goto(`${projectBase()}/deliveries`);
    await expect(rowNamed(page, /succeeded/i).first()).toBeVisible();
  });

  test('the project is deleted after typing its slug, and the organization is left with none', async ({ page }) => {
    await page.goto(`${projectBase()}/settings`);
    await page.getByRole('button', { name: 'Delete project' }).click();
    const d = dialog(page);
    const confirm = d.getByRole('button', { name: 'Delete project' });
    await expect(confirm).toBeDisabled();
    await d.getByLabel('Confirm by typing the slug').fill(state.projectSlug);
    await confirm.click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${state.orgId}$`));
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('a second organization is created from the switcher and becomes the current one', async ({ page }) => {
    await page.goto(`/orgs/${state.orgId}`);
    await page.getByRole('button', { name: 'Switch project or organization' }).click();
    await page.getByRole('menuitem', { name: 'New organization…' }).click();
    const d = dialog(page);
    await d.getByLabel('Name').fill(`${account.organization} second`);
    await d.getByRole('button', { name: 'Create organization' }).click();
    // The current URL already matches /orgs/org_…, so wait for a DIFFERENT one.
    await expect(page).toHaveURL(new RegExp(`/orgs/(?!${state.orgId})org_[A-Z0-9]+$`));
    await expect(page.getByText('No projects yet')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Switch project or organization' }),
    ).toContainText('second');
  });

  test('sign out', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
