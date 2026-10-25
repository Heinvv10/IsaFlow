/**
 * Change-of-financial-year-end acceptance (browser). Run against a DEV server on a
 * fresh test company only:
 *   FY_E2E_STATE=<storageState.json> FY_E2E_BASE_URL=http://localhost:3243 \
 *     node_modules/.bin/playwright test -c playwright-fiscal-year.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /fiscal-year-end-change\.spec\.ts/,
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.FY_E2E_BASE_URL || 'http://localhost:3243',
    headless: true,
    storageState: process.env.FY_E2E_STATE,
    viewport: { width: 1440, height: 1000 },
  },
});
