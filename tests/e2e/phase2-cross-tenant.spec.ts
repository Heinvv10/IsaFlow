// tests/e2e/phase2-cross-tenant.spec.ts
import { test, expect } from '@playwright/test';

const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL!;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD!;
const FOREIGN_COMPANY_ID = process.env.E2E_FOREIGN_COMPANY_ID!; // a company the owner is NOT a member of

test('authenticated user cannot access another tenant via cookie forge', async ({ request }) => {
  // Sign in
  const login = await request.post(`${APP_URL}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const sc = login.headers()['set-cookie'];
  const accessCookie = sc.match(/sb-access-token=[^;]+/)?.[0] ?? '';

  // Forge active_company_id cookie to point at a company we aren't a member of
  const forgedCookie = `${accessCookie}; active_company_id=${FOREIGN_COMPANY_ID}`;

  const r = await request.get(`${APP_URL}/api/accounting/customers`, {
    headers: { cookie: forgedCookie },
  });
  expect(r.status()).toBe(403); // withAuth membership check rejects
});
