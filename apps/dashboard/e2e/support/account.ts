import { expect, type Page } from '@playwright/test';
import { latestMailTo, linkInMail } from './mailpit';

/** One account per run, so a rerun never collides with a verified address. */
export function freshAccount() {
  const stamp = Date.now().toString(36);
  return {
    name: `E2E Operator ${stamp}`,
    email: `e2e-${stamp}@example.test`,
    organization: `E2E Org ${stamp}`,
    password: `Correct-Horse-${stamp}-Battery`,
  };
}

export type Account = ReturnType<typeof freshAccount>;

/**
 * Register through the UI. `POST /v1/auth/register` is throttled at 5 per hour
 * per address, so a run registers exactly ONE account and every spec shares it.
 */
export async function register(page: Page, account: Account): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Work email').fill(account.email);
  await page.getByLabel('Organization').fill(account.organization);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Enumeration-safe 202: the page must not claim the account exists, only
  // that mail may have been sent.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** Follow the verification link Mailpit received for this address. */
export async function verifyFromMail(page: Page, account: Account): Promise<void> {
  const mail = await latestMailTo(account.email, 'Confirm your email');
  const link = linkInMail(mail.text, '/verify-email');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
}

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/orgs\//);
  await dismissProductTour(page);
}

/**
 * A first visit opens the product tour on top of the page. Skipping it is
 * recorded on the account (`POST /v1/auth/onboarding-completed`), so this is
 * a no-op from the second sign-in on.
 */
export async function dismissProductTour(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip tour' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await skip.click();
    await expect(skip).toBeHidden();
  }
}

/**
 * The account every spec file shares, created by 01-auth.spec.ts and handed
 * on through a file because Playwright gives each spec file a fresh module
 * scope. Keyed by run so a rerun never collides with a verified address.
 */
export const SHARED_ACCOUNT_FILE = new URL('../.shared-account.json', import.meta.url);

export async function saveSharedAccount(account: Account): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(SHARED_ACCOUNT_FILE, JSON.stringify(account, null, 2));
}

export async function loadSharedAccount(): Promise<Account> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(SHARED_ACCOUNT_FILE, 'utf8')) as Account;
}
