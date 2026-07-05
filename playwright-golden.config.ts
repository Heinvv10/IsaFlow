/**
 * Golden-paths E2E config (A–Z fix programme, Phase 0).
 *
 * Runs the money-path suite in tests/e2e/golden-paths/ against ANY environment:
 *   BASE_URL=http://localhost:3200 (default — workspace dev server)
 *   BASE_URL=https://app.isaflow.co.za (post-deploy prod-Demo verification)
 *
 * NOTE: never default to localhost:3101 — on velo-server that port is the
 * PRODUCTION next-server, not a dev instance.
 *
 * Specs are HTTP-only where possible (APIRequestContext) so the same suite
 * works in CI, against dev, and against prod Demo. Serial workers: the specs
 * share the Demo company's books.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/golden-paths',
  globalSetup: './tests/e2e/golden-paths/_global-setup.ts',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3200',
    headless: true,
    storageState: 'tests/e2e/.auth/golden-session.json',
  },
});
