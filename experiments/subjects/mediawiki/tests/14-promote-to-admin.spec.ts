import { test, expect } from '@playwright/test';
import { freshAdmin, freshUser } from './support/api';
import { login } from './support/ui';

test('promote to admin', async ({ page }) => {
  const user = await freshUser();
  const admin = await freshAdmin();
  await login(page, admin);
  await page.getByRole('link', { name: 'Special pages', exact: true }).click();
  await page.getByRole('link', { name: 'User rights', exact: true }).click();
  await page.locator('#username').fill(user);
  await page.locator('#mw-userrights-form1 input[type=submit]').click();
  await page.locator('#wpGroup-sysop').click();
  await page.locator('#wpReason').fill('promotion');
  await page.locator('[name=saveusergroups]').click();
  await expect(page.locator('#wpGroup-sysop')).toBeChecked();
  await expect(page.locator('#mw-content-text li.mw-logline-rights').first()).toContainText(`changed group membership for ${user} from (none) to administrator (promotion)`);
});
