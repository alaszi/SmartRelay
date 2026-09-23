import { expect, test } from '@playwright/test';
import { firstLinkIn, latestEmailTextTo } from './mailpit';

/**
 * Phase 4's "done when" bar (MASTER_PLAN section 14): relay creation for Module 1, covering the
 * full path a new user actually takes — register, verify, walk the 4-step wizard (MASTER_PLAN
 * section 10), and see the relay land on the dashboard. Does not exercise "Send Test Payload":
 * that performs a real delivery to a live third-party SMS provider (decision D9), which isn't
 * something an automated suite should depend on staying reachable.
 */
test('creates a Webhook → SMS relay end to end', async ({ page }) => {
  const email = `playwright-${Date.now()}@example.com`;
  const password = 'hunter22222';

  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  const emailText = await latestEmailTextTo(email);
  await page.goto(firstLinkIn(emailText).replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.getByText('Your email is verified.')).toBeVisible();

  await page.goto('/relays/new');
  await page.getByLabel('Relay name').fill('Order notifications');
  await page.getByText('Webhook → SMS', { exact: false }).first().click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 2 (Trigger): the relay now exists and shows its real ingest URL.
  await expect(page.getByText('Ingest URL')).toBeVisible();
  await expect(page.locator('input[readonly]').first()).toHaveValue(/\/i\//);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 3 (Destination): SMSLink is the default provider.
  await expect(page.getByRole('heading', { name: 'Destination' })).toBeVisible();
  await page.getByLabel('Connection ID').fill('12345');
  await page.getByLabel('Password', { exact: true }).fill('super-secret-password');
  await page.getByLabel('Message').fill('Hi {{$.customer.name}}, your order shipped!');
  await expect(page.getByText(/Preview: Hi Ana/)).toBeVisible();
  await page.getByRole('button', { name: 'Save destination' }).click();

  // Step 4 (Test): reached only once the config actually saved.
  await expect(page.getByRole('heading', { name: 'Send Test Payload' })).toBeVisible();
  await expect(page.getByText('costs €0.025 on success')).toBeVisible();

  await page.goto('/dashboard');
  const row = page.getByRole('row', { name: /Order notifications/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Webhook → SMS')).toBeVisible();
  await expect(row.getByText('Active')).toBeVisible();
});
