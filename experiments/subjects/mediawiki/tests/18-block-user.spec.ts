import { test, expect } from '@playwright/test';
import { freshAdmin, freshUser } from './support/api';
import { login } from './support/ui';

test('block user', async ({ page }) => {
  const user = await freshUser();
  const admin = await freshAdmin();
  await login(page, admin);
  await page.getByRole('link', { name: 'Special pages', exact: true }).click();
  await page.getByRole('link', { name: 'Block user', exact: true }).click();
  await page.locator('[name=wpTarget]').fill(user);
  await page.locator('[name=wpAutoBlock]').click();
  await page.locator('[name=wpExpiry-other]').fill('indefinite');
  await page.getByRole('button', { name: 'Block' }).click();
  await expect(page.locator('#mw-content-text > p').first()).toContainText(`${user} has been blocked.`);
});
