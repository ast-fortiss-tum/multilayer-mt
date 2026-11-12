import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('create redirect', async ({ page }) => {
  const id = uid();
  const target = `Software testing ${id}`;
  const title = `Testing ${id}`;
  await (await admin()).edit(target, 'According to the IEEE/ANSI 1059 definition, software testing is the process of analyzing a software item to detect the differences between existing and required conditions (that is defects/errors/bugs) and to evaluate the features of the software item.');
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.locator('.ve-ui-mwNoticesPopupTool-item').first().waitFor();
  await page.locator('.oo-ui-popupWidget').getByRole('button', { name: 'Close' }).click();
  await page.locator('#ca-edit a').click();
  await page.locator('#wpTextbox1').fill(`#REDIRECT [[${target}]]`);
  await page.locator('#wpSave').click();
  await expect(page.locator('.redirectText')).toHaveText(target);
});
