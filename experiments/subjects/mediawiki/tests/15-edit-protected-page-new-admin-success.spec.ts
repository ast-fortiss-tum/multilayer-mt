import { test, expect } from '@playwright/test';
import { admin, freshUser, uid } from './support/api';
import { DOC_END, login, searchReady } from './support/ui';

const TEXT = 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).';
const MORE = ' Selenium WebDriver accepts commands (sent in Selenese, or via a Client API) and sends them to a browser.';

test('edit protected page as new admin succeeds', async ({ page }) => {
  const id = uid();
  const title = `Selenium WebDriver ${id}`;
  const api = await admin();
  await api.edit(`Template:Software ${id}`, 'Developer: {{{dev}}} Latest version: {{{ver}}}');
  await api.edit(title, `{{Software ${id}|dev=Selenium|ver=3.141.59}}${TEXT}`);
  await api.protect(title);
  const user = await freshUser();
  await api.addGroups(user, ['sysop'], 'promotion');
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.locator('.ve-ce-documentNode').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type(MORE);
  await page.getByRole('button', { name: 'Save changes…' }).click();
  await page.locator('.ve-ui-mwSaveDialog-summary textarea').fill('Page expanded');
  await page.locator('.ve-ui-mwSaveDialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-content-text')).toHaveText(`Developer: Selenium Latest version: 3.141.59${TEXT}${MORE}`, { useInnerText: true });
});
