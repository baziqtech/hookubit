import { expect, test } from '@playwright/test';
import { freshAccount, register, saveSharedAccount, signIn, verifyFromMail } from './support/account';

/**
 * Registration -> verification mail -> verify -> sign in, through the real
 * control API and the real SMTP path (Mailpit). Nothing here is mocked.
 *
 * This file creates THE account for the run (registration is throttled at 5
 * per hour per address) and hands it to the later spec files.
 */
test.describe.serial('accounts', () => {
  const account = freshAccount();

  test('the demo-data banner is absent: this build talks to the API', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText(/demo data/i)).toHaveCount(0);
  });

  test('registration is accepted and sign-in before verification is refused with the verification hint', async ({ page }) => {
    await register(page, account);
    await saveSharedAccount(account);

    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/verify/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('the verification link from the mail verifies the address and sign-in lands in the organization', async ({ page }) => {
    await verifyFromMail(page, account);
    await signIn(page, account);
    await expect(page.getByText(account.organization).first()).toBeVisible();
  });

  test('sign out ends the session', async ({ page }) => {
    await signIn(page, account);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/orgs');
    await expect(page).toHaveURL(/\/login/);
  });
});
