import { test, expect } from '@playwright/test';
import { admin, freshUser, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('edit protected page forbidden', async ({ page }) => {
  const title = `Selenium WebDriver ${uid()}`;
  const api = await admin();
  await api.edit(title, 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).');
  await api.protect(title);
  const user = await freshUser({ hideWelcome: false });
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.goto(page.url() + '?veaction=edit');
  await page.locator('.ve-init-mw-welcomeDialog').getByRole('button', { name: 'Start editing' }).click();
  await expect(page.locator('.ve-ui-mwNoticesPopupTool-item p').first()).toHaveText('You do not have permission to edit this page, for the following reason:');
  await expect(page.locator('.permissions-errors')).toHaveText('This page has been protected to prevent editing or other actions.');
});
