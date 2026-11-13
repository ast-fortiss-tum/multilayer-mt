import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { DOC_START, login, searchReady } from './support/ui';

const TEXT = 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).';

test('apply template', async ({ page }) => {
  const id = uid();
  const title = `Selenium WebDriver ${id}`;
  const template = `Software ${id}`;
  const api = await admin();
  await api.edit(`Template:${template}`, 'Developer: {{{dev}}} Latest version: {{{ver}}}');
  await api.edit(title, TEXT);
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: 'Edit source', exact: true }).click();
  await page.locator('#wpTextbox1').click();
  await page.locator('#wpTextbox1').press(DOC_START);
  await page.locator('#wpTextbox1').pressSequentially(`{{${template}|dev=Selenium|ver=3.141.59}}`);
  await page.locator('#wpSave').click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-content-text')).toContainText('Developer: Selenium Latest version: 3.141.59', { useInnerText: true });
});
