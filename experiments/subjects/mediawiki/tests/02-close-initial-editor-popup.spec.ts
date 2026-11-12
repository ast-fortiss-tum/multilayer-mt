import { test, expect } from '@playwright/test';
import { freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('close initial editor popup', async ({ page }) => {
  const admin = await freshAdmin({ hideWelcome: false });
  const title = `Software testing ${uid()}`;
  await login(page, admin);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: title, exact: true }).click();
  const welcome = page.locator('.ve-init-mw-welcomeDialog');
  await expect(welcome.getByRole('button', { name: 'Start editing' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Start editing' }).click();
  await expect(welcome).toBeHidden();
});
