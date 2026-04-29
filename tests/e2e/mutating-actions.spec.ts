/**
 * Phase 2 — Mutating-action audit: admin surface
 * Env: http://localhost:3200, ISAFlow Demo (00000000-0000-0000-0000-000000000001)
 * Covers: company suspend/activate, user suspend/activate, user role change,
 *         plan CRUD, subscription create/cancel, invoice create/mark-paid,
 *         webhook redeliver.
 * See mutating-actions-accounting.spec.ts for journal-entry tests.
 */
import { test, expect } from '@playwright/test';
import {
  BASE, DEMO_COMPANY_ID,
  initBrowser, closeBrowser, closeDbPool, getSharedPage,
  apiPost, apiPatch, apiDelete,
  dbQuery, dbRun, screenshot, recordResult, saveResults,
} from './mutating-actions-helpers';

// Test user: non-owner member of demo company (role=manager), safe to mutate
const TEST_USER_ID = 'dfa4bffe-23d5-4fed-8226-e84843f7ebf3';
const TEST_USER_INITIAL_ROLE = 'manager';

test.beforeAll(async () => {
  await initBrowser();
});

test.afterAll(async () => {
  saveResults();
  await closeBrowser();
  await closeDbPool();
});

// ─── 1. Company suspend → activate ──────────────────────────────────────────

test('company: suspend then re-activate', async () => {
  const [before] = await dbQuery<{ status: string }>(
    `SELECT status FROM companies WHERE id = $1`, [DEMO_COMPANY_ID],
  );
  // Guard: if the company is already suspended (concurrent run or prior crash),
  // fail loudly rather than silently passing a no-op suspend.
  expect(before.status, 'company must be active before suspend test').toBe('active');

  const t0 = Date.now();
  const { status: s1, body: b1 } = await apiPost(
    `/api/admin/companies/${DEMO_COMPANY_ID}/suspend`,
    { reason: 'Audit Phase 2 test suspension' },
  );
  const latency = Date.now() - t0;
  expect(s1, `suspend: ${JSON.stringify(b1)}`).toBe(200);
  expect((b1 as { data?: { suspended?: boolean } }).data?.suspended).toBe(true);

  const [mid] = await dbQuery<{ status: string }>(
    `SELECT status FROM companies WHERE id = $1`, [DEMO_COMPANY_ID],
  );
  expect(mid.status).toBe('suspended');

  const page = getSharedPage();
  await page.goto(`${BASE}/admin/companies/${DEMO_COMPANY_ID}`);
  const shot = await screenshot(page, 'company-suspended');

  const { status: s2 } = await apiPost(
    `/api/admin/companies/${DEMO_COMPANY_ID}/activate`, {},
  );
  expect(s2).toBe(200);

  const [restored] = await dbQuery<{ status: string }>(
    `SELECT status FROM companies WHERE id = $1`, [DEMO_COMPANY_ID],
  );
  // Assert the literal expected value, not before.status, so re-activation is
  // verified independently of whatever state we started from.
  expect(restored.status).toBe('active');
  recordResult({
    action: 'company.suspend→activate', pass: true, statusCode: 200, latencyMs: latency,
    dbDiff: { before: before.status, after: 'suspended', restored: restored.status },
    screenshotPath: shot, notes: 'suspend→activate cycle; DB restored to active',
  });
});

// ─── 2. User suspend → activate ──────────────────────────────────────────────

test('user: suspend then re-activate', async () => {
  const [before] = await dbQuery<{ status: string }>(
    `SELECT status FROM users WHERE id = $1`, [TEST_USER_ID],
  );
  const t0 = Date.now();
  const { status: s1 } = await apiPost(
    `/api/admin/users/${TEST_USER_ID}/suspend`, { reason: 'Audit Phase 2 test' },
  );
  const latency = Date.now() - t0;
  expect(s1, 'user suspend').toBe(200);

  const [mid] = await dbQuery<{ status: string }>(
    `SELECT status FROM users WHERE id = $1`, [TEST_USER_ID],
  );
  expect(mid.status).toBe('suspended');

  const { status: s2 } = await apiPost(`/api/admin/users/${TEST_USER_ID}/activate`, {});
  expect(s2).toBe(200);

  const [restored] = await dbQuery<{ status: string }>(
    `SELECT status FROM users WHERE id = $1`, [TEST_USER_ID],
  );
  expect(restored.status).toBe(before.status);
  recordResult({
    action: 'user.suspend→activate', pass: true, statusCode: 200, latencyMs: latency,
    dbDiff: { before: before.status, after: 'suspended', restored: restored.status },
    screenshotPath: '', notes: 'user suspend→activate cycle verified',
  });
});

// ─── 3. User role change ──────────────────────────────────────────────────────

test('user: role change manager→admin→manager', async () => {
  const [before] = await dbQuery<{ role: string }>(
    `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2`,
    [TEST_USER_ID, DEMO_COMPANY_ID],
  );
  const t0 = Date.now();
  // company_id is not sent in the body: the admin endpoint resolves the target
  // company from the x-company-id header set in the shared browser context
  // (pages/api/admin/users/[id].ts → withAuth → req.companyId).
  const { status: s1 } = await apiPatch(`/api/admin/users/${TEST_USER_ID}`, { role: 'admin', company_id: DEMO_COMPANY_ID });
  const latency = Date.now() - t0;
  expect(s1, 'role promote').toBe(200);

  const [mid] = await dbQuery<{ role: string }>(
    `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2`,
    [TEST_USER_ID, DEMO_COMPANY_ID],
  );
  expect(mid.role).toBe('admin');

  const { status: s2 } = await apiPatch(
    `/api/admin/users/${TEST_USER_ID}`, { role: TEST_USER_INITIAL_ROLE, company_id: DEMO_COMPANY_ID },
  );
  expect(s2).toBe(200);

  const [restored] = await dbQuery<{ role: string }>(
    `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2`,
    [TEST_USER_ID, DEMO_COMPANY_ID],
  );
  expect(restored.role).toBe(before.role);
  recordResult({
    action: 'user.role_change', pass: true, statusCode: 200, latencyMs: latency,
    dbDiff: { before: before.role, after: 'admin', restored: restored.role },
    screenshotPath: '', notes: 'manager→admin→manager round-trip verified',
  });
});

// ─── 4. Plan create → edit → archive ────────────────────────────────────────

test('plan: create → edit → archive', async () => {
  const planCode = `audit_test_${Date.now()}`;
  const t0 = Date.now();
  const { status: s1, body: b1 } = await apiPost(`/api/admin/billing/plans`, {
    code: planCode, name: 'Audit Test Plan', monthly_price_cents: 999, currency: 'ZAR',
  });
  const latency = Date.now() - t0;
  expect(s1, `plan create: ${JSON.stringify(b1)}`).toBe(200);

  const planId: string = (b1 as { data?: { id?: string } }).data?.id ?? '';
  expect(planId).toBeTruthy();

  const [afterCreate] = await dbQuery<{ name: string; is_active: boolean }>(
    `SELECT name, is_active FROM plans WHERE id = $1`, [planId],
  );
  expect(afterCreate.name).toBe('Audit Test Plan');
  expect(afterCreate.is_active).toBe(true);

  const { status: s2 } = await apiPatch(`/api/admin/billing/plans/${planId}`, {
    name: 'Audit Test Plan (edited)', monthly_price_cents: 1999,
  });
  expect(s2).toBe(200);

  const [afterEdit] = await dbQuery<{ name: string; monthly_price_cents: number }>(
    `SELECT name, monthly_price_cents FROM plans WHERE id = $1`, [planId],
  );
  expect(afterEdit.name).toBe('Audit Test Plan (edited)');
  expect(afterEdit.monthly_price_cents).toBe(1999);

  const { status: s3 } = await apiDelete(`/api/admin/billing/plans/${planId}`);
  expect(s3).toBe(200);

  const [afterArchive] = await dbQuery<{ is_active: boolean }>(
    `SELECT is_active FROM plans WHERE id = $1`, [planId],
  );
  expect(afterArchive.is_active).toBe(false);

  await dbRun(`DELETE FROM plans WHERE id = $1`, [planId]);
  recordResult({
    action: 'plan.create→edit→archive', pass: true, statusCode: 200, latencyMs: latency,
    dbDiff: { before: null, after: { name: 'Audit Test Plan' }, restored: 'hard-deleted' },
    screenshotPath: '', notes: 'Plan created, edited, archived, hard-deleted',
  });
});

// ─── 5. Subscription create → cancel ─────────────────────────────────────────

test('subscription: create → cancel', async () => {
  const [plan] = await dbQuery<{ id: string }>(
    `SELECT id FROM plans WHERE is_active = true AND code = 'starter' LIMIT 1`,
  );
  expect(plan?.id, 'starter plan exists').toBeTruthy();
  const t0 = Date.now();
  const { status: s1, body: b1 } = await apiPost(`/api/admin/billing/subscriptions`, {
    company_id: DEMO_COMPANY_ID, plan_id: plan.id, billing_cycle: 'monthly',
    notes: 'Audit Phase 2 test subscription',
  });
  const latency = Date.now() - t0;
  expect(s1, `sub create: ${JSON.stringify(b1)}`).toBe(200);

  const subId: string = (b1 as { data?: { id?: string } }).data?.id ?? '';
  expect(subId).toBeTruthy();

  const [afterCreate] = await dbQuery<{ status: string }>(
    `SELECT status FROM subscriptions WHERE id = $1`, [subId],
  );
  expect(afterCreate.status).toBe('active');

  const { status: s2 } = await apiPatch(`/api/admin/billing/subscriptions/${subId}`, {
    status: 'cancelled',
  });
  expect(s2).toBe(200);

  const [afterCancel] = await dbQuery<{ status: string }>(
    `SELECT status FROM subscriptions WHERE id = $1`, [subId],
  );
  expect(afterCancel.status).toBe('cancelled');
  await dbRun(`DELETE FROM subscriptions WHERE id = $1`, [subId]);
  recordResult({
    action: 'subscription.create→cancel', pass: true, statusCode: 200, latencyMs: latency,
    dbDiff: { before: null, after: 'active', restored: 'cancelled' },
    screenshotPath: '', notes: 'Subscription created → cancelled → hard-deleted',
  });
});

// ─── 6. Invoice create → mark-paid ───────────────────────────────────────────

test('invoice: create → mark-paid', async () => {
  const t0 = Date.now();
  const { status: s1, body: b1 } = await apiPost(`/api/admin/billing/invoices`, {
    company_id: DEMO_COMPANY_ID, subtotal_cents: 5000, tax_cents: 750,
    total_cents: 5750, due_date: '2026-12-31', notes: 'Audit Phase 2 test invoice',
  });
  const latency = Date.now() - t0;
  expect(s1, `invoice create: ${JSON.stringify(b1)}`).toBe(200);

  const invoiceId: string = (b1 as { data?: { id?: string } }).data?.id ?? '';
  expect(invoiceId).toBeTruthy();

  const [afterCreate] = await dbQuery<{ status: string }>(
    `SELECT status FROM admin_invoices WHERE id = $1`, [invoiceId],
  );
  expect(afterCreate.status).toBe('draft');

  const { status: s2 } = await apiPost(
    `/api/admin/billing/invoices/${invoiceId}/mark-paid`, { payment_method: 'eft' },
  );
  expect(s2).toBe(200);

  const [afterPaid] = await dbQuery<{ status: string; payment_method: string }>(
    `SELECT status, payment_method FROM admin_invoices WHERE id = $1`, [invoiceId],
  );
  expect(afterPaid.status).toBe('paid');
  expect(afterPaid.payment_method).toBe('eft');

  const page = getSharedPage();
  await page.goto(`${BASE}/admin/billing/invoices`);
  const shot = await screenshot(page, 'invoice-list-after-paid');
  await dbRun(`DELETE FROM admin_invoices WHERE id = $1`, [invoiceId]);
  recordResult({
    action: 'invoice.create→mark-paid', pass: true, statusCode: 200, latencyMs: latency,
    dbDiff: { before: null, after: 'paid', restored: null },
    screenshotPath: shot, notes: 'Invoice created, marked paid, hard-deleted for isolation',
  });
});

// ─── 7. Webhook redeliver ─────────────────────────────────────────────────────

test('webhook: redeliver (no endpoints in dev — expect graceful non-5xx)', async () => {
  // Scope to the demo company to avoid crossing into a foreign tenant's endpoint.
  const rows = await dbQuery<{ id: string }>(
    `SELECT id FROM webhook_endpoints WHERE company_id = $1 LIMIT 1`,
    [DEMO_COMPANY_ID],
  );
  const ep = rows[0];

  if (!ep) {
    // No webhook endpoints registered for the demo company — skip cleanly.
    test.skip(true, 'SKIP: no webhook_endpoints for demo company — redeliver not testable without foreign-tenant data');
    return;
  }

  const t0 = Date.now();
  const { status, body } = await apiPost(`/api/admin/webhooks/${ep.id}/redeliver`, {});
  const latency = Date.now() - t0;
  expect(status, `redeliver not 5xx: ${JSON.stringify(body)}`).toBeLessThan(500);
  recordResult({
    action: 'webhook.redeliver', pass: status < 500, statusCode: status,
    latencyMs: latency, dbDiff: { before: null, after: null, restored: null },
    screenshotPath: '', notes: `status=${status}`,
  });
});
