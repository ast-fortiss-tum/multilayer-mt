import { test, expect } from '@playwright/test';
import { freshAdmin } from './support/api';
import { login } from './support/ui';

test('create empty user fails', async ({ page }) => {
  const admin = await freshAdmin();
  await login(page, admin);
  await page.getByRole('link', { name: 'Special pages', exact: true }).click();
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await page.locator('#wpCreateaccount').click();
  await expect(page.locator('#wpName2')).toHaveJSProperty('validationMessage', 'Please fill out this field.');
});
