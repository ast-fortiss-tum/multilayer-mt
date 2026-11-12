import { test, expect } from '@playwright/test';
import { admin, uid } from './support/api';
import { searchReady } from './support/ui';

const TEXT = 'According to the IEEE/ANSI 1059 definition, software testing is the process of analyzing a software item to detect the differences between existing and required conditions (that is defects/errors/bugs) and to evaluate the features of the software item.';

test('search page', async ({ page }) => {
  const title = `Software testing ${uid()}`;
  await (await admin()).edit(title, TEXT);
  await page.goto('/');
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await expect(page.locator('#firstHeading')).toHaveText(title);
  await expect(page.locator('#mw-content-text')).toHaveText(TEXT, { useInnerText: true });
});
