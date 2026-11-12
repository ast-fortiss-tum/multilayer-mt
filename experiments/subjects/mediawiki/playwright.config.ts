import { defineConfig, devices } from '@playwright/test';

// Start the application first: ./docker/setup.sh
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.MW_URL || 'http://localhost:8080',
    locale: 'en-US',
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      // BEWT runs Chrome with --screen-info={1920x1080} and a maximised window.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
  ],
});
