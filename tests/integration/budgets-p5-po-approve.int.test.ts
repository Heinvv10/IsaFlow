/**
 * Budgets P5-3 (spec §0 decision 8c, §3b call site 3, §4, T7): POST /api/accounting/purchase-orders/[id]/approve,
 * through the real route (withAuth → app_user under forced RLS) on real PostgreSQL. The approve action stamps
 * approved_by / approved_at, runs the budget check on the PO's lines (month = order_date, ex-VAT line totals,
 * the PO's own commitment excluded), and follows the bills' policy matrix. Each case uses its own month of the
 * fixture's FY2027 budget (opex BB-6100 at CC1: FT 1 000, HT 0; nob BB-6300 unbudgeted).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { formatMoney as R } from '@/lib/money/formatMoney';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { auditFor, dropBillFixture, eventsFor, makeBill, seedBillFixture, setPolicy, callRoute, type BillFixture } from './helpers/budgetBillFixture';
import { approvePo, makePo, poState } from './helpers/budgetPoFixture';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let other: BillFixture;
const viewer = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-approve');
  other = await seedBillFixture(pool, 'po-approve-other');
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [viewer, `${viewer}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')", [f.co, viewer]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager, viewer].map((u) => `purchase-order-approve:${u}`)]);
    await dropBillFixture(pool, f);
    await dropBillFixture(pool, other);
    await pool.query('DELETE FROM users WHERE id = $1', [viewer]);
  } finally {
    await pool.end();
  }
}, 60_000);

const ftPo = (month: string, amount: number, cc1: 'FT' | 'HT' = 'FT') => makePo(pool, f, month, [{ acct: f.acc.opex, amount, cc1: f.cc[cc1] }]);
const poAudit = async (po: string) => (await pool.query(
  "SELECT action, user_id, changes FROM audit_log WHERE entity_type = 'purchase_order' AND entity_id = $1 ORDER BY created_at", [po])).rows;

describe('approve: stamps and the warn policy', () => {
  it('within budget: 200, status approved, approved_by / approved_at stamped, event pass, both audit rows', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await ftPo('2026-03', 400);
    const r = await approvePo(f, f.manager, po);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    const s = await poState(pool, po);
    expect(s).toMatchObject({ status: 'approved', approved_by: f.manager, updated_by: f.manager });
    expect(s.approved_at).toBeInstanceOf(Date);
    expect((await eventsFor(pool, po)).map((e) => [e.outcome, e.channel, e.decided_by])).toEqual([['pass', 'ui', f.manager]]);
    expect((await auditFor(pool, po)).map((a) => a.action)).toEqual(['approve']);
    const [audit] = await poAudit(po);
    expect(audit).toMatchObject({ action: 'approve', user_id: f.manager });
    expect(audit.changes.fields).toEqual([{ field: 'status', old: 'draft', new: 'approved', label: 'Status' }]);
  });

  it('the month is the order date (decision 8b), not the day it was keyed in', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await ftPo('2026-07', 300);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const [ev] = await eventsFor(pool, po);
    expect(ev!.lines.map((l) => l.month)).toEqual(['2026-07']);
  });

  it('over budget with a reason: approved, event warn with the reason', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await ftPo('2026-04', 1500);
    const r = await approvePo(f, f.owner, po, { budgetReason: '  Annual licence  ' });
    expect(r.statusCode).toBe(200);
    expect((r.body.data as { budgetWarnings?: string[] }).budgetWarnings).toEqual([
      `Over budget: BB-6100 Opex · FT Fibertime · 2026-04: remaining ${R(1000)}, this order ${R(1500)}`]);
    expect((await poState(pool, po)).status).toBe('approved');
    expect(await eventsFor(pool, po)).toEqual([expect.objectContaining({ outcome: 'warn', reason: 'Annual licence', decided_by: f.owner })]);
  });

  it('over budget without a reason: 400 BUDGET_REASON_REQUIRED and nothing written', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await ftPo('2026-05', 1500);
    for (const body of [{}, { budgetReason: '   ' }]) {
      const r = await approvePo(f, f.owner, po, body);
      expect(r.statusCode).toBe(400);
      expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_REASON_REQUIRED', lines: [expect.objectContaining({ over: true, amount: 1500 })] });
    }
    expect(await poState(pool, po)).toMatchObject({ status: 'draft', approved_by: null, approved_at: null });
    expect(await eventsFor(pool, po)).toHaveLength(0);
    expect(await poAudit(po)).toHaveLength(0);
  });
});

describe('approve: the block policy', () => {
  it('over budget: 409, status unchanged, the refused event persisted', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await ftPo('2026-06', 1500);
    const r = await approvePo(f, f.manager, po, { budgetReason: 'please' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain(`BB-6100 Opex · FT Fibertime · 2026-06: remaining ${R(1000)}, this order ${R(1500)}`);
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED', overrideRefused: false });
    expect(await poState(pool, po)).toMatchObject({ status: 'draft', approved_by: null, approved_at: null });
    expect(await eventsFor(pool, po)).toEqual([expect.objectContaining({ outcome: 'refused', policy: 'block', decided_by: f.manager, reason: 'please' })]);
    expect((await auditFor(pool, po)).map((a) => a.action)).toEqual(['reject']);
    expect(await poAudit(po)).toHaveLength(0);
  });

  it('owner override with a reason: approved, event override', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await ftPo('2026-08', 1500);
    const r = await approvePo(f, f.owner, po, { budgetOverride: true, budgetReason: 'Board approved' });
    expect(r.statusCode).toBe(200);
    expect(await poState(pool, po)).toMatchObject({ status: 'approved', approved_by: f.owner });
    expect(await eventsFor(pool, po)).toEqual([expect.objectContaining({ outcome: 'override', reason: 'Board approved' })]);
  });

  it('a manager cannot override: 409 override refused, the refused event recorded, status unchanged', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await ftPo('2026-09', 1500);
    const r = await approvePo(f, f.manager, po, { budgetOverride: true, budgetReason: 'I say so' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED', overrideRefused: true });
    expect((await poState(pool, po)).status).toBe('draft');
    expect((await eventsFor(pool, po)).map((e) => [e.outcome, e.decided_by])).toEqual([['refused', f.manager]]);
  });

  it('a zero budget is a budget: one cent over it is refused', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await ftPo('2026-10', 0.01, 'HT');
    expect((await approvePo(f, f.manager, po)).statusCode).toBe(409);
  });

  it('a line with no account is "No budget" and never blocks; an unbudgeted account neither', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await makePo(pool, f, '2026-11', [{ acct: null, amount: 99_999, cc1: f.cc.FT }, { acct: f.acc.nob, amount: 99_999 }]);
    const r = await approvePo(f, f.manager, po);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((await poState(pool, po)).status).toBe('approved');
    expect(await eventsFor(pool, po)).toHaveLength(0); // nothing checked against a budget
  });

  it('the PO\'s own lines are judged together on one slice (each fits alone)', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await makePo(pool, f, '2026-12', [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }, { acct: f.acc.opex, amount: 600, cc1: f.cc.FT }]);
    const r = await approvePo(f, f.manager, po);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain(`remaining ${R(1000)}, this order ${R(1200)}`);
  });

  it('an approved bill on the slice counts against the PO (actual), so does another approved PO (committed)', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 500, cc1: f.cc.FT }], { date: '2027-01-15' });
    expect((await callRoute(actionRoute as never, f, f.owner, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill })).statusCode).toBe(200);
    await makePo(pool, f, '2027-01', [{ acct: f.acc.opex, amount: 300, cc1: f.cc.FT }], { status: 'approved' });
    const { po } = await ftPo('2027-01', 250);
    const r = await approvePo(f, f.manager, po);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain(`remaining ${R(200)}, this order ${R(250)}`);
  });
});

describe('approve: status, tenancy, roles', () => {
  it('only a draft or submitted PO can be approved (400 naming the status); a submitted one can', async () => {
    await setPolicy(pool, f, 'off');
    for (const status of ['approved', 'partially_received', 'received', 'cancelled']) {
      const { po } = await makePo(pool, f, '2026-03', [{ acct: f.acc.nob, amount: 10 }], { status });
      const r = await approvePo(f, f.owner, po);
      expect(r.statusCode, status).toBe(400);
      expect(r.body.error?.message).toContain(status.replace(/_/g, ' '));
      expect((await poState(pool, po)).status).toBe(status);
    }
    const { po } = await makePo(pool, f, '2026-03', [{ acct: f.acc.nob, amount: 10 }], { status: 'submitted' });
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    expect(await eventsFor(pool, po)).toHaveLength(0); // policy off: no event
    expect(await poAudit(po)).toHaveLength(1); // the approval itself is always audited
  });

  it('another company\'s PO is 404 and untouched; a bad id is 404', async () => {
    const { po } = await makePo(pool, other, '2026-03', [{ acct: other.acc.nob, amount: 10 }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(404);
    expect((await poState(pool, po)).status).toBe('draft');
    expect((await approvePo(f, f.owner, 'not-a-uuid')).statusCode).toBe(404);
  });

  it('a viewer is refused (403)', async () => {
    const { po } = await ftPo('2026-03', 10);
    expect((await approvePo(f, viewer, po)).statusCode).toBe(403);
    expect((await poState(pool, po)).status).toBe('draft');
  });

  it('the body is checked: an over-long reason, a non-boolean override or an unknown key is 422, nothing written', async () => {
    const { po } = await ftPo('2026-03', 10);
    for (const body of [{ budgetReason: 'x'.repeat(2001) }, { budgetOverride: 'yes' }, { status: 'approved' }]) {
      expect((await approvePo(f, f.owner, po, body)).statusCode, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect((await poState(pool, po)).status).toBe('draft');
  });

  it('the route is rate-limited per user (120 a minute): the 121st call is 429', async () => {
    const user = crypto.randomUUID();
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'manager')", [f.co, user]);
    try {
      const bad = crypto.randomUUID(); // 404, nothing written; still charged
      for (let i = 0; i < 120; i += 1) expect((await approvePo(f, user, bad)).statusCode).not.toBe(429);
      expect((await approvePo(f, user, bad)).statusCode).toBe(429);
    } finally {
      await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [`purchase-order-approve:${user}`]);
      await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
      await pool.query('DELETE FROM users WHERE id = $1', [user]);
    }
  }, 60_000);
});
