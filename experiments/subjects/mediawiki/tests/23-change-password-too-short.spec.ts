import { test, expect } from '@playwright/test';
import { admin, freshUser } from './support/api';
import { login } from './support/ui';

test('change password too short', async ({ page }) => {
  // In the BEWT suite the user is an administrator (PromoteToAdminTest) and
  // blocked (BlockUserTest) at this point; administrators need 10 characters.
  const user = await freshUser();
  const api = await admin();
  await api.addGroups(user, ['sysop']);
  await api.block(user);
  await login(page, user);
  await page.getByRole('link', { name: 'Special pages', exact: true }).click();
  await page.getByRole('link', { name: 'Change credentials', exact: true }).click();
  await page.locator('#mw-content-text dl dd a').click();
  await page.locator('[name=password]').fill('vznb');
  await page.locator('[name=retype]').fill('vznb');
  await page.locator('#change_credentials_submit').click();
  await expect(page.locator('#mw-content-text form .mw-htmlform-ooui-header-errors .oo-ui-messageWidget')).toHaveText('Passwords must be at least 10 characters.');
});
