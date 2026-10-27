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
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { devOnlySpecPattern } from './tests/e2e/golden-paths/helpers/devOnlySpecs';

export default defineConfig({
  testDir: './tests/e2e/golden-paths',
  // scripts/verify-deploy.sh sets GOLDEN_SKIP_A11Y=1 for the post-deploy run against production, and Playwright then
  // never LOADS any spec whose first lines carry `// golden:dev-only` (see helpers/devOnlySpecs.ts); a --grep-invert
  // would still import it. A spec needs the marker if it uses axe, writes data or a sandbox company, measures timing
  // or layout shift, or depends on dev data. Production verify specs must be read-only and deterministic, because a
  // red run rolls the deploy back. Never edit a regex here: mark the spec.
  testMatch: '**/*.spec.ts',
  testIgnore: process.env.GOLDEN_SKIP_A11Y === '1' ? devOnlySpecPattern(path.join(__dirname, 'tests/e2e/golden-paths')) : undefined,
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
