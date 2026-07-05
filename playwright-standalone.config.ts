/**
 * Config for standalone (non-golden) E2E regression specs in tests/e2e/.
 * These are ad-hoc/per-feature specs — NOT part of the blocking golden gate
 * (tests/e2e/golden-paths/ + playwright-golden.config.ts), which stays
 * scoped to the 12 money paths.
 *
 *   BASE_URL=http://localhost:3200 bunx playwright test tests/e2e/<spec> --config playwright-standalone.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/golden-paths/**'],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3200',
    headless: true,
  },
});
