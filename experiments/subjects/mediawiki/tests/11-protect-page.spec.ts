import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, moduleReady, searchReady } from './support/ui';

test('protect page', async ({ page }) => {
  const title = `Selenium WebDriver ${uid()}`;
  await (await admin()).edit(title, 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).');
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.locator('#p-cactions-checkbox').click();
  await page.getByRole('link', { name: 'Protect', exact: true }).click();
  await moduleReady(page, 'mediawiki.action.protect');
  await page.locator('#mwProtect-level-edit').click();
  await page.getByRole('option', { name: 'Allow only administrators' }).filter({ visible: true }).click();
  await page.locator('#mw-Protect-submit button').click();
  await page.locator('#p-cactions-checkbox').click();
  await page.getByRole('link', { name: 'Change protection', exact: true }).click();
  await moduleReady(page, 'mediawiki.action.protect');
  await expect(page.locator('#mwProtect-level-edit .oo-ui-dropdownWidget-handle .oo-ui-labelElement-label')).toHaveText('Allow only administrators');
});
