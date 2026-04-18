// tests/e2e/phase2-auth.spec.ts
import { test, expect } from '@playwright/test';

const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@isaflow.test';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'SuperSecret12345!';

test.describe('phase 2 — auth golden path', () => {
  test('login → dashboard → switch company → logout', async ({ page, request }) => {
    // Assumes a user + company exist from dev seed. Register flow is covered separately.
    await page.goto(`${APP_URL}/login`);
    await page.fill('input[name="email"]', OWNER_EMAIL);
    await page.fill('input[name="password"]', OWNER_PASSWORD);
    await page.click('button[type="submit"]');

    await page.waitForURL(/.*\/accounting(\/|$).*/);

    const me = await request.get(`${APP_URL}/api/auth/me`);
    expect(me.status()).toBe(200);

    await request.post(`${APP_URL}/api/auth/logout`);
    await page.goto(`${APP_URL}/accounting/dashboard`);
    await expect(page).toHaveURL(/.*\/login.*/);
  });
});
