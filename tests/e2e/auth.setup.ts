/**
 * Auth setup for E2E tests — uses API login to get session cookie
 */
import { test as setup, expect } from '@playwright/test';

const AUTH_FILE = 'tests/e2e/.auth/session.json';

setup('authenticate', async ({ request, browser }) => {
  // Login via API
  const loginResponse = await request.post('/api/auth/login', {
    data: {
      email: 'admin@isaflow.co.za',
      password: 'admin123',
    },
  });

  expect(loginResponse.status()).toBe(200);

  // The login sets a cookie in the response. Create a browser context with it.
  const context = await browser.newContext();
  const cookies = await loginResponse.headers()['set-cookie'];

  if (cookies) {
    // Parse set-cookie header and add to context
    const cookieParts = cookies.split(';')[0]!.split('=');
    const cookieName = cookieParts[0]!;
    const cookieValue = cookieParts.slice(1).join('=');

    await context.addCookies([{
      name: cookieName,
      value: cookieValue,
      domain: 'localhost',
      path: '/',
    }]);
  }

  // Navigate to verify auth works
  const page = await context.newPage();
  await page.goto('/accounting');
  // Should get 200 (dashboard), not 307 (redirect to login)
  await page.waitForLoadState('networkidle');

  // Save storage state
  await context.storageState({ path: AUTH_FILE });
  await context.close();
});
