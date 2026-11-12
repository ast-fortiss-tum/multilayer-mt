import { test, expect } from '@playwright/test';
import { freshAdmin, uid } from './support/api';
import { login, searchReady } from './support/ui';

test('create blank page gets warning', async ({ page }) => {
  // In the BEWT suite the previous edits used the source editor, which
  // MediaWiki remembers: red links then open the source editor.
  const admin = await freshAdmin({ editor: 'wikitext' });
  const title = `Empty ${uid()}`;
  await login(page, admin);
  await searchReady(page);
  await page.locator('#searchInput').pressSequentially(title);
  await page.locator('#searchInput').press('Enter');
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.locator('#wpSave').click();
  await expect(page.locator('#mw-blankarticle')).toHaveText(
    'Warning: The page you are creating is blank. If you click "Save page" again, the page will be created without any content.',
  );
});
