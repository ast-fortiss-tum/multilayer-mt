import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { DOC_END, login, searchReady } from './support/ui';

const TEXT = 'According to the IEEE/ANSI 1059 definition, software testing is the process of analyzing a software item to detect the differences between existing and required conditions (that is defects/errors/bugs) and to evaluate the features of the software item.';
const MORE = ' Testing is performed by running test cases against the system under test (SUT) and collecting their results.';

test('edit page', async ({ page }) => {
  const title = `Software testing ${uid()}`;
  await (await admin()).edit(title, TEXT);
  const user = await freshAdmin();
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
  await expect(page.locator('#mw-content-text')).toHaveText(TEXT + MORE, { useInnerText: true });
});
