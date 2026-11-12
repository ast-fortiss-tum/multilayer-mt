import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('shows the login form', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Sign in');
  await expect(page.locator('#login-btn')).toBeVisible();
});

test('logs in with valid credentials', async ({ page }) => {
  await login(page);
  await expect(page.locator('#welcome')).toContainText('Welcome');
});

test('rejects invalid credentials', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'alice@example.com');
  await page.fill('#password', 'wrong-password');
  await page.click('#login-btn');
  await expect(page.locator('#login-error')).toBeVisible();
});

test('navigates to the about page', async ({ page }) => {
  await page.goto('/');
  await page.click('#about-link');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#about-text')).toContainText('todo application');
});
