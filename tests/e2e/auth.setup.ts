/**
 * Auth setup for E2E tests — logs in via page navigation to get proper cookies
 */
import { test as setup, expect } from '@playwright/test';

const AUTH_FILE = 'tests/e2e/.auth/session.json';

setup('authenticate', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Call login API directly and capture the Set-Cookie response
  const response = await page.request.post('/api/auth/login', {
    data: {
      email: 'admin@isaflow.co.za',
      password: 'admin123',
    },
  });

  expect(response.status()).toBe(200);

  // The page.request shares the cookie jar with the page context,
  // so HttpOnly cookies from Set-Cookie are automatically applied.
  // Navigate to verify the auth cookie works.
  await page.goto('/accounting');
  await page.waitForLoadState('networkidle');

  // Save the authenticated state (cookies + localStorage)
  await context.storageState({ path: AUTH_FILE });
  await context.close();
});
