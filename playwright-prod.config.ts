import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'tests/e2e/screenshots/audit-results.json' }]],
  use: {
    baseURL: 'https://app.isaflow.co.za',
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
    storageState: 'tests/e2e/.auth/prod-session.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
