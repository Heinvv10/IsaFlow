// tests/e2e/phase2-invite.spec.ts
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const ADMIN_DB_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL!;
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL!;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD!;

async function fetchInviteToken(email: string): Promise<string> {
  const pool = new Pool({ connectionString: ADMIN_DB_URL, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT token FROM company_invitations WHERE email = $1 AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (rows.length === 0) throw new Error('no invite row');
    return (rows[0] as { token: string }).token;
  } finally { await pool.end(); }
}

test('owner invites → accept flow → new user in dashboard', async ({ request }) => {
  const inviteeEmail = `e2e-invitee-${Date.now()}@isaflow.test`;

  // Sign in as owner
  const login = await request.post(`${APP_URL}/api/auth/login`, {
    data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const ownerCookies = login.headers()['set-cookie'];

  // Create invite
  const inv = await request.post(`${APP_URL}/api/invitations`, {
    data: { email: inviteeEmail, role: 'manager' },
    headers: { cookie: ownerCookies },
  });
  expect(inv.status()).toBe(201);

  const token = await fetchInviteToken(inviteeEmail);

  // Accept in a fresh context (no cookies)
  const accept = await request.post(`${APP_URL}/api/invitations/${token}/accept`, {
    data: { password: 'NewUserPwd12345!', firstName: 'E2E', lastName: 'User' },
  });
  expect(accept.status()).toBe(200);

  // New user can access /api/auth/me
  const meCookies = accept.headers()['set-cookie'];
  const me = await request.get(`${APP_URL}/api/auth/me`, { headers: { cookie: meCookies } });
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect((body as { data: { memberships: unknown[] } }).data.memberships.length).toBeGreaterThan(0);
});
