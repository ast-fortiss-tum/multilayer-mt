import { test, expect } from '@playwright/test';
import { freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

const TEXT = 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).';

test('create page from source', async ({ page }) => {
  const admin = await freshAdmin();
  const title = `Selenium WebDriver ${uid()}`;
  await login(page, admin);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.locator('.ve-ui-mwNoticesPopupTool-item').first().waitFor();
  await page.locator('.oo-ui-popupWidget').getByRole('button', { name: 'Close' }).click();
  await page.locator('#ca-edit a').click();
  await page.locator('#wpTextbox1').fill(TEXT);
  await page.locator('#wpSave').click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-content-text')).toHaveText(TEXT, { useInnerText: true });
});
