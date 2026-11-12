import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  expect: { timeout: 3_000 },
  fullyParallel: true,
  use: { baseURL: 'http://localhost:3123', actionTimeout: 3_000 },
  webServer: { command: 'node server.js', url: 'http://localhost:3123', reuseExistingServer: true },
});
