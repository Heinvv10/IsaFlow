import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3101',
    headless: true,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        storageState: 'tests/e2e/.auth/session.json',
      },
      dependencies: ['setup'],
    },
    {
      // API-only tests that manage their own auth — no setup dependency
      name: 'api',
      testMatch: /admin-auth\.spec\.ts/,
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
