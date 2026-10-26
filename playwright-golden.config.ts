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
  // scripts/verify-deploy.sh sets GOLDEN_SKIP_A11Y=1 for the post-deploy run against production. The a11y spec is a
  // dev/CI gate (its baseline is keyed to dev data), and ignoring it here means Playwright never LOADS the file, so
  // a missing @axe-core/playwright cannot break a deploy check either. A --grep-invert would still import it.
  // The theme specs (o-theme-contrast, o2-theme-behaviour) and q2-top-nav-axe are the same kind of gate: axe on dev data, and a red
  // contrast run against production must not roll a deploy back. s-shell-cls-mobile measures layout shift, which depends on the
  // machine and the data, and loads the theme helpers (axe) for its screenshots.
  testIgnore: process.env.GOLDEN_SKIP_A11Y === '1' ? /(^|\/)(n-a11y-main-screens|o-theme-contrast|o2-theme-behaviour|t-report-filter-dates|q2-top-nav-axe|o3-banner-titles|s-shell-cls-mobile)\.spec\.ts$/ : undefined,
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
