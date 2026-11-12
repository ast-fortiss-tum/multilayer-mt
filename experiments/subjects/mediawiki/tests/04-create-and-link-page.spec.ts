import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

const TARGET_TEXT = 'According to the IEEE/ANSI 1059 definition, software testing is the process of analyzing a software item to detect the differences between existing and required conditions (that is defects/errors/bugs) and to evaluate the features of the software item.';

test('create and link page', async ({ page }) => {
  const id = uid();
  const target = `Software testing ${id}`;
  await (await admin()).edit(target, TARGET_TEXT);
  const user = await freshAdmin();
  const title = `E2E Web Testing ${id}`;
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.locator('.ve-ui-mwNoticesPopupTool-item').first().waitFor();
  await page.locator('.oo-ui-popupWidget').getByRole('button', { name: 'Close' }).click();
  await page.locator('.ve-ce-documentNode').click();
  await page.keyboard.type('End-to-End (E2E) testing is a  ');
  await page.keyboard.type('[[');
  await page.getByLabel('Search internal pages').fill(target);
  await page.locator('.ve-ui-mwLinkAnnotationInspector .oo-ui-menuOptionWidget').filter({ hasText: target }).first().click();
  await page.locator('.ve-ce-documentNode').click();
  await expect(page.locator('.ve-ui-mwLinkAnnotationInspector.oo-ui-window-active')).toHaveCount(0);
  await page.keyboard.press('End');
  await page.keyboard.type(' technique that aims to test a system as a whole, as a human tester would');
  await page.getByRole('button', { name: 'Save page…' }).click();
  await page.locator('.ve-ui-mwSaveDialog-summary textarea').fill('Page created');
  await page.locator('.ve-ui-mwSaveDialog').getByRole('button', { name: 'Save page' }).click();
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await page.locator('#mw-content-text').getByRole('link', { name: target, exact: true }).click();
  await expect(page.locator('#firstHeading')).toHaveText(target);
  await expect(page.locator('#mw-content-text')).toHaveText(TARGET_TEXT, { useInnerText: true });
});
