/**
 * Budgets P5-2 (spec §3b, §6 T5/T6, §7): the budget check at a single UI bill approval, through
 * the real route (withAuth → app_user under forced RLS) on real PostgreSQL. Each case uses its own
 * month of the fixture's FY2027 budget (opex BB-6100 at CC1: FT 1 000, HT 0; nob BB-6300 unbudgeted),
 * so the cases are independent. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  auditFor, billState, callRoute, dropBillFixture, eventsFor, makeBill, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'route'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const URL = '/api/accounting/supplier-invoices-action';
const approve = (user: string, invoiceId: string, extra: Record<string, unknown> = {}) =>
  callRoute(actionRoute as never, f, user, URL, { action: 'approve', invoiceId, ...extra });
const overBill = (month: string, cc1: 'FT' | 'HT' = 'FT', amount = 1500) =>
  makeBill(pool, f, [{ acct: f.acc.opex, amount, cc1: f.cc[cc1] }], { date: `${month}-15` });

describe('warn policy, UI channel', () => {
  it('over budget with a reason: approved, event warn with the reason, audit entry (entity budget)', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await overBill('2026-04');
    const r = await approve(f.owner, bill, { budgetReason: '  Year-end stock run  ' });
    expect(r.statusCode).toBe(200);
    expect(await billState(pool, bill)).toMatchObject({ status: 'approved', gl_journal_entry_id: expect.any(String) });
    const [ev, ...more] = await eventsFor(pool, bill);
    expect(more).toHaveLength(0);
    expect(ev).toMatchObject({ outcome: 'warn', policy: 'warn', channel: 'ui', reason: 'Year-end stock run', decided_by: f.owner });
    expect(ev!.lines[0]).toMatchObject({ month: '2026-04', budget: 1000, remaining: 1000, amount: 1500, over: true, accountLabel: 'BB-6100 Opex', sliceLabel: 'FT Fibertime' });
    const [audit] = await auditFor(pool, bill);
    expect(audit).toMatchObject({ action: 'approve', user_id: f.owner });
    expect(audit!.changes.metadata).toMatchObject({ budgetCheck: 'warn', policy: 'warn', channel: 'ui', reason: 'Year-end stock run', overLines: '1' });
  });

  it('over budget without a reason: 400 BUDGET_REASON_REQUIRED and nothing written', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await overBill('2026-05');
    const before = await billState(pool, bill);
    for (const extra of [{}, { budgetReason: '   ' }]) {
      const r = await approve(f.owner, bill, extra);
      expect(r.statusCode).toBe(400);
      expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_REASON_REQUIRED' });
    }
    expect(await billState(pool, bill)).toEqual(before);
    expect(await eventsFor(pool, bill)).toHaveLength(0);
    expect(await auditFor(pool, bill)).toHaveLength(0);
  });

  it('within budget: approved, event pass (no reason asked)', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await overBill('2026-03', 'FT', 400);
    expect((await approve(f.manager, bill)).statusCode).toBe(200);
    expect((await eventsFor(pool, bill)).map((e) => e.outcome)).toEqual(['pass']);
  });
});

describe('block policy, UI channel', () => {
  it('over budget: 409, no journal, status and amount_paid unchanged, the refused event persisted', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await overBill('2026-07');
    const before = await billState(pool, bill);
    const r = await approve(f.manager, bill, { budgetReason: 'please' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain('BB-6100 Opex · FT Fibertime · 2026-07: remaining R1,000.00, this bill R1,500.00');
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED', overrideRefused: false });
    const after = await billState(pool, bill);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: 'draft', gl_journal_entry_id: null, amount_paid: '0.00' });
    const events = await eventsFor(pool, bill);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'refused', policy: 'block', channel: 'ui', decided_by: f.manager, reason: 'please' });
    expect((await auditFor(pool, bill))[0]).toMatchObject({ action: 'reject', user_id: f.manager });
  });

  it('owner override with a reason: approved, event override', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await overBill('2026-08');
    const r = await approve(f.owner, bill, { budgetOverride: true, budgetReason: 'Board approved the overspend' });
    expect(r.statusCode).toBe(200);
    expect((await billState(pool, bill)).status).toBe('approved');
    expect(await eventsFor(pool, bill)).toEqual([expect.objectContaining({ outcome: 'override', reason: 'Board approved the overspend', decided_by: f.owner })]);
  });

  it('owner override without a reason: 400, nothing written', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await overBill('2026-08', 'FT', 2500);
    const r = await approve(f.owner, bill, { budgetOverride: true });
    expect(r.statusCode).toBe(400);
    expect((await billState(pool, bill)).status).toBe('draft');
    expect(await eventsFor(pool, bill)).toHaveLength(0);
  });

  it('a manager cannot override: 409 (override refused), the refused event recorded', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await overBill('2026-09');
    const r = await approve(f.manager, bill, { budgetOverride: true, budgetReason: 'I say so' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED', overrideRefused: true });
    expect((await billState(pool, bill)).status).toBe('draft');
    expect((await eventsFor(pool, bill)).map((e) => [e.outcome, e.decided_by])).toEqual([['refused', f.manager]]);
  });

  it('no budget never blocks: an unbudgeted account, and the unassigned slice of a CC1-grain account', async () => {
    await setPolicy(pool, f, 'block');
    const unbudgeted = await makeBill(pool, f, [{ acct: f.acc.nob, amount: 99_999 }], { date: '2026-10-15' });
    const unassigned = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 99_999 }], { date: '2026-10-15' });
    for (const bill of [unbudgeted, unassigned]) {
      expect((await approve(f.manager, bill)).statusCode).toBe(200);
      expect((await billState(pool, bill)).status).toBe('approved');
      expect(await eventsFor(pool, bill)).toHaveLength(0); // nothing checked: no event
    }
  });

  it('a zero budget is a budget: one cent over it is refused', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await overBill('2026-10', 'HT', 0.01);
    const r = await approve(f.manager, bill);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain('HT Hometech · 2026-10: remaining R0.00, this bill R0.01');
  });

  it('two lines on one slice are judged together (each fits alone)', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }, { acct: f.acc.opex, amount: 600, cc1: f.cc.FT }],
      { date: '2026-11-15' });
    const r = await approve(f.manager, bill);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain('remaining R1,000.00, this bill R1,200.00');
  });

  it('the reused-journal branch is not checked (its journal is already in actuals): approved, no event', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await overBill('2026-12', 'FT', 5000);
    const je = crypto.randomUUID();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source)
                     VALUES ($1, $2, $3, '2026-12-15', 'posted', $4, 'legacy', 'auto_supplier_invoice')`, [je, f.co, `LEG-${je.slice(0, 6)}`, f.owner]);
      await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, description)
                     VALUES ($1, $2, $3, 5000, 0, $4, 'legacy'), ($1, $2, $5, 0, 5000, NULL, 'legacy')`, [je, f.co, f.acc.opex, f.cc.FT, f.acc.ap]);
      await c.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [bill, je]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const r = await approve(f.manager, bill);
    expect(r.statusCode).toBe(200);
    expect(await billState(pool, bill)).toMatchObject({ status: 'approved', gl_journal_entry_id: je });
    expect(await eventsFor(pool, bill)).toHaveLength(0);
  });
});
