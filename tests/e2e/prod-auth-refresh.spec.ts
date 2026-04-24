/**
 * Refresh tests/e2e/.auth/prod-session.json with a fresh admin token.
 * Run this before the audit spec: `bunx playwright test prod-auth.setup.ts --config=playwright-prod.config.ts`
 */
import { test as setup } from '@playwright/test';

const PROD_SESSION = 'tests/e2e/.auth/prod-session.json';
const EMAIL = process.env.PROD_TEST_EMAIL;
const PASSWORD = process.env.PROD_TEST_PASSWORD;
if (!EMAIL || !PASSWORD) {
  throw new Error('PROD_TEST_EMAIL and PROD_TEST_PASSWORD must be set in the environment.');
}

setup('refresh prod admin session', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  const res = await page.request.post('/api/auth/login', {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
  }

  // CSRF cookie is issued by middleware on authenticated page loads, not the API.
  // Hit the dashboard so it's set on the context too.
  await page.goto('/accounting');
  await page.waitForLoadState('networkidle');

  await context.storageState({ path: PROD_SESSION });
  await context.close();
  // eslint-disable-next-line no-console
  console.log(`  stored: ${PROD_SESSION}`);
});
