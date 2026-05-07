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

  let restored = false;
  try {
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
    restored = true;

    const [restoredRow] = await dbQuery<{ status: string }>(
      `SELECT status FROM companies WHERE id = $1`, [DEMO_COMPANY_ID],
    );
    // Assert the literal expected value, not before.status, so re-activation is
    // verified independently of whatever state we started from.
    expect(restoredRow.status).toBe('active');
    recordResult({
      action: 'company.suspend→activate', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: before.status, after: 'suspended', restored: restoredRow.status },
      screenshotPath: shot, notes: 'suspend→activate cycle; DB restored to active',
    });
  } finally {
    if (!restored) {
      await apiPost(`/api/admin/companies/${DEMO_COMPANY_ID}/activate`, {}).catch(() => undefined);
    }
  }
});

// ─── 2. User suspend → activate ──────────────────────────────────────────────

test('user: suspend then re-activate', async () => {
  const [testUser] = await dbQuery<{ id: string; role: string }>(
    `SELECT u.id, cu.role
       FROM company_users cu
       JOIN users u ON u.id = cu.user_id
      WHERE cu.company_id = $1 AND cu.role NOT IN ('owner')
      LIMIT 1`,
    [DEMO_COMPANY_ID],
  );
  if (!testUser) { test.skip(true, 'SKIP: no non-owner user in demo company'); return; }
  const testUserId = testUser.id;

  const [before] = await dbQuery<{ status: string }>(
    `SELECT status FROM users WHERE id = $1`, [testUserId],
  );
  const t0 = Date.now();

  let restored = false;
  try {
    const { status: s1 } = await apiPost(
      `/api/admin/users/${testUserId}/suspend`, { reason: 'Audit Phase 2 test' },
    );
    const latency = Date.now() - t0;
    expect(s1, 'user suspend').toBe(200);

    const [mid] = await dbQuery<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`, [testUserId],
    );
    expect(mid.status).toBe('suspended');

    const { status: s2 } = await apiPost(`/api/admin/users/${testUserId}/activate`, {});
    expect(s2).toBe(200);
    restored = true;

    const [restoredRow] = await dbQuery<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`, [testUserId],
    );
    expect(restoredRow.status).toBe(before.status);
    recordResult({
      action: 'user.suspend→activate', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: before.status, after: 'suspended', restored: restoredRow.status },
      screenshotPath: '', notes: 'user suspend→activate cycle verified',
    });
  } finally {
    if (!restored) {
      await apiPost(`/api/admin/users/${testUserId}/activate`, {}).catch(() => undefined);
    }
  }
});

// ─── 3. User role change ──────────────────────────────────────────────────────

test('user: role change manager→admin→manager', async () => {
  const [testUser] = await dbQuery<{ id: string; role: string }>(
    `SELECT u.id, cu.role
       FROM company_users cu
       JOIN users u ON u.id = cu.user_id
      WHERE cu.company_id = $1 AND cu.role NOT IN ('owner')
      LIMIT 1`,
    [DEMO_COMPANY_ID],
  );
  if (!testUser) { test.skip(true, 'SKIP: no non-owner user in demo company'); return; }
  const testUserId = testUser.id;
  const testUserInitialRole = testUser.role;

  const [before] = await dbQuery<{ role: string }>(
    `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2`,
    [testUserId, DEMO_COMPANY_ID],
  );
  const t0 = Date.now();

  let restored = false;
  try {
    // company_id is not sent in the body: the admin endpoint resolves the target
    // company from the x-company-id header set in the shared browser context
    // (pages/api/admin/users/[id].ts → withAuth → req.companyId).
    const { status: s1 } = await apiPatch(`/api/admin/users/${testUserId}`, { role: 'admin', company_id: DEMO_COMPANY_ID });
    const latency = Date.now() - t0;
    expect(s1, 'role promote').toBe(200);

    const [mid] = await dbQuery<{ role: string }>(
      `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2`,
      [testUserId, DEMO_COMPANY_ID],
    );
    expect(mid.role).toBe('admin');

    const { status: s2 } = await apiPatch(
      `/api/admin/users/${testUserId}`, { role: testUserInitialRole, company_id: DEMO_COMPANY_ID },
    );
    expect(s2).toBe(200);
    restored = true;

    const [restoredRow] = await dbQuery<{ role: string }>(
      `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2`,
      [testUserId, DEMO_COMPANY_ID],
    );
    expect(restoredRow.role).toBe(before.role);
    recordResult({
      action: 'user.role_change', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: before.role, after: 'admin', restored: restoredRow.role },
      screenshotPath: '', notes: 'manager→admin→manager round-trip verified',
    });
  } finally {
    if (!restored) {
      await apiPatch(`/api/admin/users/${testUserId}`, { role: testUserInitialRole, company_id: DEMO_COMPANY_ID }).catch(() => undefined);
    }
  }
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

  const planId = (b1 as { data?: { id?: string } }).data?.id;
  expect(planId, 'plan create: id missing from response').toBeTruthy();
  const planIdStr = planId as string;

  let cleaned = false;
  try {
    const [afterCreate] = await dbQuery<{ name: string; is_active: boolean }>(
      `SELECT name, is_active FROM plans WHERE id = $1`, [planIdStr],
    );
    expect(afterCreate.name).toBe('Audit Test Plan');
    expect(afterCreate.is_active).toBe(true);

    const { status: s2 } = await apiPatch(`/api/admin/billing/plans/${planIdStr}`, {
      name: 'Audit Test Plan (edited)', monthly_price_cents: 1999,
    });
    expect(s2).toBe(200);

    const [afterEdit] = await dbQuery<{ name: string; monthly_price_cents: number }>(
      `SELECT name, monthly_price_cents FROM plans WHERE id = $1`, [planIdStr],
    );
    expect(afterEdit.name).toBe('Audit Test Plan (edited)');
    expect(afterEdit.monthly_price_cents).toBe(1999);

    const { status: s3 } = await apiDelete(`/api/admin/billing/plans/${planIdStr}`);
    expect(s3).toBe(200);

    const [afterArchive] = await dbQuery<{ is_active: boolean }>(
      `SELECT is_active FROM plans WHERE id = $1`, [planIdStr],
    );
    expect(afterArchive.is_active).toBe(false);

    await dbRun(`DELETE FROM plans WHERE id = $1`, [planIdStr]);
    cleaned = true;

    recordResult({
      action: 'plan.create→edit→archive', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: null, after: { name: 'Audit Test Plan' }, restored: 'hard-deleted' },
      screenshotPath: '', notes: 'Plan created, edited, archived, hard-deleted',
    });
  } finally {
    if (!cleaned && planIdStr) {
      await dbRun(`DELETE FROM plans WHERE id = $1`, [planIdStr]).catch(() => undefined);
    }
  }
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

  const subId = (b1 as { data?: { id?: string } }).data?.id;
  expect(subId, 'sub create: id missing from response').toBeTruthy();
  const subIdStr = subId as string;

  let cleaned = false;
  try {
    const [afterCreate] = await dbQuery<{ status: string }>(
      `SELECT status FROM subscriptions WHERE id = $1`, [subIdStr],
    );
    expect(afterCreate.status).toBe('active');

    const { status: s2 } = await apiPatch(`/api/admin/billing/subscriptions/${subIdStr}`, {
      status: 'cancelled',
    });
    expect(s2).toBe(200);

    const [afterCancel] = await dbQuery<{ status: string }>(
      `SELECT status FROM subscriptions WHERE id = $1`, [subIdStr],
    );
    expect(afterCancel.status).toBe('cancelled');

    await dbRun(`DELETE FROM subscriptions WHERE id = $1`, [subIdStr]);
    cleaned = true;

    recordResult({
      action: 'subscription.create→cancel', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: null, after: 'active', restored: 'cancelled' },
      screenshotPath: '', notes: 'Subscription created → cancelled → hard-deleted',
    });
  } finally {
    if (!cleaned && subIdStr) {
      await dbRun(`DELETE FROM subscriptions WHERE id = $1`, [subIdStr]).catch(() => undefined);
    }
  }
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

  const invoiceId = (b1 as { data?: { id?: string } }).data?.id;
  expect(invoiceId, 'invoice create: id missing from response').toBeTruthy();
  const invoiceIdStr = invoiceId as string;

  let cleaned = false;
  try {
    const [afterCreate] = await dbQuery<{ status: string }>(
      `SELECT status FROM admin_invoices WHERE id = $1`, [invoiceIdStr],
    );
    expect(afterCreate.status).toBe('draft');

    const { status: s2 } = await apiPost(
      `/api/admin/billing/invoices/${invoiceIdStr}/mark-paid`, { payment_method: 'eft' },
    );
    expect(s2).toBe(200);

    const [afterPaid] = await dbQuery<{ status: string; payment_method: string }>(
      `SELECT status, payment_method FROM admin_invoices WHERE id = $1`, [invoiceIdStr],
    );
    expect(afterPaid.status).toBe('paid');
    expect(afterPaid.payment_method).toBe('eft');

    const page = getSharedPage();
    await page.goto(`${BASE}/admin/billing/invoices`);
    const shot = await screenshot(page, 'invoice-list-after-paid');

    await dbRun(`DELETE FROM admin_invoices WHERE id = $1`, [invoiceIdStr]);
    cleaned = true;

    recordResult({
      action: 'invoice.create→mark-paid', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: null, after: 'paid', restored: null },
      screenshotPath: shot, notes: 'Invoice created, marked paid, hard-deleted for isolation',
    });
  } finally {
    if (!cleaned && invoiceIdStr) {
      await dbRun(`DELETE FROM admin_invoices WHERE id = $1`, [invoiceIdStr]).catch(() => undefined);
    }
  }
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
  expect([200, 202, 204, 404], `redeliver returned unexpected status ${status}: ${JSON.stringify(body)}`).toContain(status);
  recordResult({
    action: 'webhook.redeliver', pass: [200, 202, 204, 404].includes(status), statusCode: status,
    latencyMs: latency, dbDiff: { before: null, after: null, restored: null },
    screenshotPath: '', notes: `status=${status}`,
  });
});
