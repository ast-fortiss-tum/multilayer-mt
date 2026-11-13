/** Counterpart of BEWT's BaseTest: open the wiki and log in through the UI. */
import { Page } from '@playwright/test';
import { PASSWORD } from './api';

/**
 * Keyboard chords for start/end of document. BEWT sends Ctrl+Home/Ctrl+End
 * (Linux/Windows); macOS uses Cmd+Up/Cmd+Down.
 */
export const DOC_START = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
export const DOC_END = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

export async function login(page: Page, user: string, password = PASSWORD): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Log in', exact: true }).click();
  await page.locator('#wpName1').fill(user);
  await page.locator('#wpPassword1').fill(password);
  await page.locator('#wpLoginAttempt').click();
  await page.waitForURL(/Main_Page/);
}

/**
 * Wait until the search box is driven by MediaWiki's search-suggest script.
 * Before that, Enter submits the no-JS form and always lands on the results
 * page (BEWT's MainPage sleeps 1 s before typing for the same reason).
 */
export async function searchReady(page: Page): Promise<void> {
  // The module is loaded on the first focus of the search box.
  await page.locator('#searchInput').click();
  await page.waitForFunction(() => (window as any).mw?.loader?.getState('mediawiki.searchSuggest') === 'ready');
}

/** Wait until a ResourceLoader module (and so the widgets it enhances) is ready. */
export async function moduleReady(page: Page, module: string): Promise<void> {
  await page.waitForFunction((m) => (window as any).mw?.loader?.getState(m) === 'ready', module);
}
