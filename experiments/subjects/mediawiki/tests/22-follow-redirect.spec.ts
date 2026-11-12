import { test, expect } from '@playwright/test';
import { admin, freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('follow redirect', async ({ page }) => {
  const id = uid();
  const target = `Software testing ${id}`;
  const title = `Testing ${id}`;
  const api = await admin();
  await api.edit(target, 'According to the IEEE/ANSI 1059 definition, software testing is the process of analyzing a software item to detect the differences between existing and required conditions (that is defects/errors/bugs) and to evaluate the features of the software item.');
  await api.edit(title, `#REDIRECT [[${target}]]`);
  const user = await freshAdmin();
  await login(page, user);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await expect(page.locator('#firstHeading')).toHaveText(target);
  await expect(page.locator('.mw-redirectedfrom')).toHaveText(`(Redirected from ${title})`);
});
