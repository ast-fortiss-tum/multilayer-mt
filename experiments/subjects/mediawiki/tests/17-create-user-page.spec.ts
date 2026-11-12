import { test, expect } from '@playwright/test';
import { freshUser } from './support/api';
import { login } from './support/ui';

test('create user page', async ({ page }) => {
  const user = await freshUser();
  await login(page, user);
  await page.locator('#pt-userpage a').click();
  await page.getByRole('link', { name: 'Create source', exact: true }).click();
  await page.locator('#wpTextbox1').fill('This is my user page');
  await page.locator('#wpSave').click();
  await expect(page.locator('#firstHeading')).toHaveText(`User:${user}`);
  await expect(page.locator('#mw-content-text')).toHaveText('This is my user page', { useInnerText: true });
});
