import { test, expect } from '@playwright/test';
import { freshAdmin, PASSWORD, uid } from './support/api';
import { login } from './support/ui';

test('create user', async ({ page }) => {
  const admin = await freshAdmin();
  const user = `User${uid()}`;
  await login(page, admin);
  await page.getByRole('link', { name: 'Special pages', exact: true }).click();
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await page.locator('#wpName2').fill(user);
  await page.locator('#wpPassword2').fill(PASSWORD);
  await page.locator('#wpRetype').fill(PASSWORD);
  await page.locator('#wpRealName').fill('Real Name 001');
  await page.locator('#wpCreateaccount').click();
  await expect(page.locator('#mw-content-text > p').first()).toHaveText(`The user account for ${user} (talk) has been created.`);
});
