import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('admin edit protected page gets warning', async ({ page }) => {
  const title = `Selenium WebDriver ${uid()}`;
  const api = await admin();
  await api.edit(title, 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).');
  await api.protect(title);
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.ve-ui-mwNoticesPopupTool-item p').first()).toHaveText(
    'Warning: This page has been protected so that only users with administrator privileges can edit it. The latest log entry is provided below for reference:',
  );
});
