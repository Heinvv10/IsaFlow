/**
 * Playwright config for Phase 2 mutating-actions audit.
 * Targets the local dev server on :3200. Does NOT reuse the shared
 * auth setup from playwright-test.config.ts — each spec manages its
 * own session so mutations are fully isolated.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1, // serial — mutations must not race
  reporter: [
    ['list'],
    ['json', { outputFile: 'tmp/mutating-actions-audit/playwright-report.json' }],
  ],
  use: {
    baseURL: 'http://localhost:3200',
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: 'mutating-actions',
      testMatch: '**/mutating-actions*.spec.ts',
      use: {
        browserName: 'chromium',
        // storageState is reset here to ensure no shared auth fixtures bleed in.
        // Authentication is performed programmatically by initBrowser() in mutating-actions-helpers.ts.
        storageState: { cookies: [], origins: [] },
      },
    },
  ],
});
