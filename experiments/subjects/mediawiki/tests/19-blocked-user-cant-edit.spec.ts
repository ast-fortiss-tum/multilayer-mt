import { test, expect } from '@playwright/test';
import { admin, editAs, freshUser } from './support/api';
import { login } from './support/ui';

test('blocked user cannot edit', async ({ page }) => {
  const user = await freshUser();
  await editAs(user, `User:${user}`, 'This is my user page');
  await (await admin()).block(user);
  await login(page, user);
  await page.locator('#pt-userpage a').click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.ve-ui-mwNoticesPopupTool-item p').first()).toHaveText('You do not have permission to edit this page, for the following reason:');
  await expect(page.locator('.permissions-errors')).toContainText('Your username or IP address has been blocked');
});
