import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('add category', async ({ page }) => {
  const title = `Selenium WebDriver ${uid()}`;
  await (await admin()).edit(title, 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).');
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  const categories = page.getByRole('combobox', { name: 'Add a category' });
  await categories.pressSequentially('Browser automation tools');
  await page.waitForTimeout(500);
  await categories.press('Enter');
  await page.getByRole('dialog', { name: 'Options' }).getByRole('button', { name: 'Apply changes' }).click();
  await page.getByRole('button', { name: 'Save changes…' }).click();
  await page.locator('.ve-ui-mwSaveDialog-summary textarea').fill('Added category');
  await page.locator('.ve-ui-mwSaveDialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-normal-catlinks ul li a')).toHaveText('Browser automation tools');
});
