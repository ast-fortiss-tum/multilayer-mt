import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('lists the existing todos', async ({ page }) => {
  await page.waitForSelector('#todo-list li');
  const items = page.locator('#todo-list li');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('Write thesis');
});

test('adds a todo', async ({ page }) => {
  await page.fill('#new-todo', 'Buy milk');
  await page.click('#add-btn');
  await expect(page.locator('#todo-list li .title').last()).toHaveText('Buy milk');
  await expect(page.locator('#status-line')).toHaveText('2 open of 3');
});

test('completes a todo', async ({ page }) => {
  const first = page.locator('#todo-list li').first();
  await first.locator('button.toggle').click();
  await expect(first.locator('.badge')).toHaveText('Done');
});

test('filters done todos', async ({ page }) => {
  await page.waitForSelector('#todo-list li');
  await page.selectOption('#filter', 'DONE');
  await expect(page.locator('#todo-list li')).toHaveCount(1);
  await expect(page.locator('#todo-list li').first()).not.toContainText('Write thesis');
});
