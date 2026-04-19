// tests/e2e/admin-auth.spec.ts
import { test, expect, type APIRequestContext } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3101';
const ADMIN_EMAIL = 'admin-e2e@test.local';
const ADMIN_PW = 'AdminE2E!Secret123';
const USER_EMAIL = 'user-e2e@test.local';
const USER_PW = 'UserE2E!Secret123';

async function loginViaApi(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email, password },
    headers: { 'content-type': 'application/json' },
  });
  expect(res.ok(), `login for ${email} failed: ${res.status()}`).toBeTruthy();
}

test.describe('admin auth', () => {
  // Use a fresh storageState per test so cookies from one login don't leak
  test.use({ storageState: { cookies: [], origins: [] } });

  test('super_admin can load admin dashboard API', async ({ request }) => {
    await loginViaApi(request, ADMIN_EMAIL, ADMIN_PW);
    const res = await request.get(`${BASE}/api/admin/dashboard-stats`, {
      headers: { 'x-admin-request': 'true' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('non-super-admin user is blocked with 403', async ({ request }) => {
    await loginViaApi(request, USER_EMAIL, USER_PW);
    const res = await request.get(`${BASE}/api/admin/dashboard-stats`, {
      headers: { 'x-admin-request': 'true' },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe('NOT_SUPER_ADMIN');
  });

  test('unauthenticated request gets 401', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/dashboard-stats`, {
      headers: { 'x-admin-request': 'true' },
    });
    expect(res.status()).toBe(401);
  });
});
