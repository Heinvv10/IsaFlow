/**
 * The rubric measurement harness (master plan wave 4, MW): tests/e2e/rubric/rubric.harness.ts.
 *
 * Dev only, never in CI or post-deploy verify. It writes in a sandbox company of its own on isaflow_dev, so it has no
 * default base URL: the guard refuses anything but http://localhost:<3271-3280>, and refuses the production ports
 * whatever the allow-list says.
 *
 *   RUBRIC_BASE_URL=http://localhost:3277 RUBRIC_RUN_ID=w4-before \
 *   RUBRIC_EVIDENCE_DIR=docs/evidence/master-plan/wave4/mw/before \
 *   bunx playwright test --config playwright-rubric.config.ts
 *
 * Logins come from ~/.secrets/isaflow-reporting-qa.env and ~/.secrets/isaflow-dev-approver.env (override with
 * RUBRIC_REQUESTER_ENV / RUBRIC_APPROVER_ENV); they must be the two dev-only QA users.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/rubric',
  testMatch: 'rubric.harness.ts',
  timeout: 45 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.RUBRIC_BASE_URL,
    headless: true,
    serviceWorkers: 'block',
  },
});
