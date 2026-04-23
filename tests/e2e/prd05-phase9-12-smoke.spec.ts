import { test, expect } from '@playwright/test';

/**
 * PRD-05 Phase 9-12 smoke — hardens the most recent surface area by
 * hitting every new API + UI route end-to-end against prod (or dev).
 *
 * Phase 9  — mirror inbox
 * Phase 10 — expense claims + mileage
 * Phase 11 — cross-tenant fraud graph
 * Phase 12 — audit-trail-as-a-product
 */

// ═══════════════════════════════════════════════════════════════════════════
// UI pages — should render without the crash-screen boundary
// ═══════════════════════════════════════════════════════════════════════════

const UI_ROUTES = [
  '/accounting/capture/settings/mirror',
  '/accounting/expenses',
  '/accounting/expenses/new',
  '/accounting/fraud/signals',
  '/accounting/audit-packs',
] as const;

for (const route of UI_ROUTES) {
  test(`page loads: ${route}`, async ({ page }) => {
    const res = await page.goto(route, { waitUntil: 'networkidle' });
    expect(res?.status(), `HTTP ${res?.status()} on ${route}`).toBeLessThan(400);

    // None of the React error-boundary titles
    const body = await page.textContent('body');
    expect(body, `Crash boundary on ${route}`).not.toContain('Something went wrong');
    expect(body, `Crash boundary on ${route}`).not.toMatch(/Minified React error/);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// API surface — should return 200/201/4xx validation, never 500
// ═══════════════════════════════════════════════════════════════════════════

const READ_APIS = [
  '/api/accounting/capture/mirror',
  '/api/accounting/expense-claims',
  '/api/accounting/fraud/signals',
  '/api/accounting/audit-exports',
] as const;

for (const api of READ_APIS) {
  test(`API GET healthy: ${api}`, async ({ request }) => {
    const res = await request.get(api);
    expect(res.status(), `${api} status`).toBeLessThan(500);
    const body = await res.json();
    expect(body).toHaveProperty('success');
  });
}

/** Pull the CSRF token out of the authed storage state so write APIs work. */
async function csrfHeaders(request: import('@playwright/test').APIRequestContext): Promise<Record<string, string>> {
  const state = await request.storageState();
  const cookie = state.cookies.find(c => c.name === 'isaflow_csrf');
  return cookie ? { 'X-CSRF-Token': cookie.value } : {};
}

// Expense claim full lifecycle — the most complex of the four phases.
// TODO: needs a fresh sb-access-token in tests/e2e/.auth/prod-session.json
// (the current legacy ff_auth_token works for GETs but the auth middleware
// refuses mutating POSTs without the Supabase JWT). Re-enable once the auth
// setup script is updated to mint a GoTrue session.
test.skip('Phase 10: expense claim draft → submit → approve → post', async ({ request }) => {
  const emps = await request.get('/api/payroll/employees?limit=1');
  const empsJson = await emps.json();
  const employeeId = empsJson?.data?.employees?.[0]?.id ?? empsJson?.data?.[0]?.id;
  test.skip(!employeeId, 'No employees in demo company');

  const accts = await request.get('/api/accounting/chart-of-accounts?limit=500');
  const list = (await accts.json()).data;
  const accounts = Array.isArray(list) ? list : (list?.accounts ?? []);
  const expense = accounts.find((a: { accountType: string }) => a.accountType === 'expense');
  const liab = accounts.find((a: { accountType: string; accountCode?: string }) =>
    a.accountType === 'liability' && a.accountCode === '2000');
  test.skip(!expense || !liab, 'Demo chart missing expense/liability accounts');

  const headers = await csrfHeaders(request);
  const cr = await request.post('/api/accounting/expense-claims', {
    data: { employeeId, title: 'E2E smoke — expense lifecycle' },
    headers,
  });
  expect(cr.status()).toBe(201);
  const claim = (await cr.json()).data.claim;

  // Add a receipt line
  const rc = await request.post(`/api/accounting/expense-claims/${claim.id}`, {
    data: {
      lineDate: '2026-04-22', merchant: 'E2E Test', description: 'Smoke test expense',
      amount: 100, vatAmount: 15, vatCode: 'STD', glAccountId: expense.id,
    },
    headers,
  });
  expect(rc.status()).toBeLessThan(400);

  // Transitions
  const sub = await request.post(`/api/accounting/expense-claims/${claim.id}/submit`, { headers });
  expect((await sub.json()).data?.claim?.status).toBe('submitted');

  const ap = await request.post(`/api/accounting/expense-claims/${claim.id}/approve`, {
    data: { decision: 'approve' }, headers,
  });
  expect((await ap.json()).data?.claim?.status).toBe('approved');

  const post = await request.post(`/api/accounting/expense-claims/${claim.id}/post`, {
    data: { reimbursementAccountId: liab.id }, headers,
  });
  const posted = (await post.json()).data?.claim;
  expect(posted?.status).toBe('posted');
  expect(posted?.postedJeId).toBeTruthy();
});

// Audit pack build + portal mint + portal HEAD
test.skip('Phase 12: audit pack build + portal invite + token verify', async ({ request }) => {
  const headers = await csrfHeaders(request);
  const build = await request.post('/api/accounting/audit-exports', {
    data: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
    headers,
  });
  expect(build.status()).toBe(201);
  const pack = (await build.json()).data.export;
  expect(pack.status).toBe('ready');
  expect(pack.pdfSha256).toMatch(/^[a-f0-9]{64}$/);

  const invite = await request.post(`/api/accounting/audit-exports/${pack.id}/sessions`, {
    data: { auditorEmail: 'e2e@smoketest.co.za', ttlHours: 1 }, headers,
  });
  expect(invite.status()).toBe(201);
  const { session, accessToken, portalUrl } = (await invite.json()).data;
  expect(portalUrl).toContain('/audit-portal/');
  expect(accessToken.length).toBeGreaterThan(30);          // base64url of 32 bytes

  // HEAD — auditor-facing auth check (no CSRF — not a tenant write)
  const head = await request.head(`/api/audit-portal/download?sessionId=${session.id}&token=${accessToken}`);
  expect(head.status()).toBe(200);
  expect(head.headers()['x-content-sha256']).toBe(pack.pdfSha256);

  // Clean up
  const revoke = await request.delete(`/api/accounting/audit-exports/${pack.id}/sessions/${session.id}`, { headers });
  expect(revoke.ok()).toBeTruthy();
});

// Fraud scan — idempotent even with no linked suppliers
test.skip('Phase 11: fraud scan returns structured result', async ({ request }) => {
  const headers = await csrfHeaders(request);
  const scan = await request.post('/api/accounting/fraud/scan', { headers });
  expect(scan.status()).toBe(200);
  const body = await scan.json();
  expect(body.data).toHaveProperty('created');
  expect(body.data).toHaveProperty('refreshed');
});
