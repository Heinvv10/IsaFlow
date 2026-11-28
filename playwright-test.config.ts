import { defineConfig } from '@playwright/test';
import { DEFAULT_DEV_BASE_URL } from './tests/e2e/helpers/devTarget';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/helpers/devTargetGlobalSetup.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    // Dev and CI only (the global setup refuses anything else): :3101 is production on velo-server.
    baseURL: process.env.BASE_URL || DEFAULT_DEV_BASE_URL,
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
