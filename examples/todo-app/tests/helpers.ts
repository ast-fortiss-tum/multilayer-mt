import { Page, expect } from '@playwright/test';

export async function login(page: Page, email = 'alice@example.com', password = 'secret1') {
  await page.goto('/');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#login-btn');
  await expect(page).toHaveURL(/\/todos$/);
}
