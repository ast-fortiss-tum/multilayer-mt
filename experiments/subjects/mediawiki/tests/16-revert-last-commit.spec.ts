import { test, expect } from '@playwright/test';
import { admin, editAs, freshAdmin, freshUser, uid } from './support/api';
import { login, searchReady } from './support/ui';

const TEXT = 'Selenium is an open source umbrella project for a range of tools and libraries aimed at supporting browser automation. It provides a playback tool for authoring functional tests across most modern web browsers, without the need to learn a test scripting language (Selenium IDE).';

test('revert last commit', async ({ page }) => {
  const title = `Selenium WebDriver ${uid()}`;
  await (await admin()).edit(title, TEXT);
  const editor = await freshUser();
  await editAs(editor, title, TEXT + ' Selenium WebDriver accepts commands (sent in Selenese, or via a Client API) and sends them to a browser.');
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: 'View history', exact: true }).click();
  await page.getByRole('link', { name: 'rollback 1 edit', exact: true }).click();
  await expect(page.locator('#mw-content-text > p').first()).toHaveText(
    `Reverted edits by ${editor} (talk | contribs | block); changed back to last revision by Admin (talk | contribs | block).`,
  );
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-content-text')).toHaveText(TEXT, { useInnerText: true });
});
