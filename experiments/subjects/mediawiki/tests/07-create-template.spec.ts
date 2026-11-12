import { test, expect } from '@playwright/test';
import { freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('create template', async ({ page }) => {
  const admin = await freshAdmin();
  const title = `Template:Software ${uid()}`;
  await login(page, admin);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.locator('#wpTextbox1').fill('Developer: {{{dev}}} Latest version: {{{ver}}}');
  await page.locator('#wpSave').click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-content-text')).toHaveText('Developer: {{{dev}}} Latest version: {{{ver}}}', { useInnerText: true });
});
