import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('delete page', async ({ page }) => {
  const title = `E2E Web Testing ${uid()}`;
  await (await admin()).edit(title, 'End-to-End (E2E) testing is a technique that aims to test a system as a whole, as a human tester would');
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.locator('#p-cactions-checkbox').click();
  await page.getByRole('link', { name: 'Delete', exact: true }).click();
  await page.locator('#wpConfirmB').click();
  await expect(page.locator('#mw-content-text > p').first()).toHaveText(`"${title}" has been deleted. See deletion log for a record of recent deletions.`);
});
