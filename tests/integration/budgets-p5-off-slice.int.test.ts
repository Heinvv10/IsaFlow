/**
 * Budgets P5-2b (Hein, 2026-11-04), single UI bill approval through the real route (withAuth → app_user under forced
 * RLS) on real PostgreSQL: a line whose account is budgeted in the primary version but which lands outside every
 * budgeted slice is REFUSED in block (409, refused event with kind 'off_slice', nothing written), needs a reason in
 * warn, and is overridable by an owner/admin as an over line is. An account with no budget anywhere stays
 * "No budget". Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0, nob BB-6300 unbudgeted, proj BB-6400 at CC2 PA only
 * (`budgetOffSliceFixture.ts`). Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMoney as R } from '@/lib/money/formatMoney';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  auditFor, billState, callRoute, dropBillFixture, eventsFor, linkBillToPo, makeBill, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { makePo } from './helpers/budgetPoFixture';
import { seedOffSlice, setBillCc2, type OffSliceExtra } from './helpers/budgetOffSliceFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
let x: OffSliceExtra;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice');
  x = await seedOffSlice(pool, f);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])', [[f.owner, f.manager].map((u) => `supplier-invoice-action:${u}`)]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const URL = '/api/accounting/supplier-invoices-action';
const approve = (user: string, invoiceId: string, extra: Record<string, unknown> = {}) =>
  callRoute(actionRoute as never, f, user, URL, { action: 'approve', invoiceId, ...extra });
/** A bill on opex with NO CC1 (opex is budgeted per CC1): the unassigned slice. */
const blankCc1 = (month: string, amount = 200) => makeBill(pool, f, [{ acct: f.acc.opex, amount }], { date: `${month}-15` });

describe('block', () => {
  it('blank CC1 on a CC1-grain account: 409, nothing written, the refused event persisted with kind off_slice', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await blankCc1('2026-04');
    const before = await billState(pool, bill);
    const r = await approve(f.manager, bill);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toContain(`BB-6100 Opex · no cost centre 1 · 2026-04: not in a budgeted slice, this bill ${R(200)}`);
    expect(r.body.error?.message).toContain('An owner or admin can override it with a reason, or cancel it and enter it again with a budgeted cost centre 1 on its line.');
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED', lines: [expect.objectContaining({ offSlice: true, over: false, amount: 200 })] });
    const after = await billState(pool, bill);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    const [ev, ...more] = await eventsFor(pool, bill);
    expect(more).toHaveLength(0);
    expect(ev).toMatchObject({ outcome: 'refused', policy: 'block', channel: 'ui', decided_by: f.manager });
    expect(ev!.lines).toEqual([expect.objectContaining({ kind: 'off_slice', offSlice: true, over: false, unassigned: true, budget: null })]);
    expect((await auditFor(pool, bill))[0]).toMatchObject({ action: 'reject', changes: { metadata: expect.objectContaining({ offSliceLines: '1', overLines: '0' }) } });
  });

  it('a PO-linked bill line posted to CC2 PB while only PA is budgeted: refused, naming PB', async () => {
    await setPolicy(pool, f, 'block');
    const { items } = await makePo(pool, f, '2026-05', [{ acct: x.proj, amount: 300, cc2: x.PA }], { status: 'approved' });
    const bill = await makeBill(pool, f, [{ acct: x.proj, amount: 300 }], { date: '2026-05-15' });
    await setBillCc2(pool, bill, x.PB);
    await linkBillToPo(pool, bill, items[0]!);
    const r = await approve(f.manager, bill);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toContain('BB-6400 Projects · PB Project B · 2026-05: not in a budgeted slice');
    expect(r.body.error?.message).toContain('with a budgeted cost centre 2 on its line');
    expect((await billState(pool, bill)).status).toBe('draft');
    expect((await eventsFor(pool, bill)).map((e) => e.outcome)).toEqual(['refused']);
  });

  it('the same bill on the budgeted slice PA is approved (pass)', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: x.proj, amount: 300 }], { date: '2026-05-15' });
    await setBillCc2(pool, bill, x.PA);
    expect((await approve(f.manager, bill)).statusCode).toBe(200);
    expect((await eventsFor(pool, bill)).map((e) => e.outcome)).toEqual(['pass']);
  });

  it('an account with no budget anywhere passes ("No budget"), no event', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.nob, amount: 99_999 }], { date: '2026-06-15' });
    expect((await approve(f.manager, bill)).statusCode).toBe(200);
    expect((await billState(pool, bill)).status).toBe('approved');
    expect(await eventsFor(pool, bill)).toHaveLength(0);
  });

  it('a zero-budget slice keeps the over rule (an over line, not off-slice)', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 0.01, cc1: f.cc.HT }], { date: '2026-06-15' });
    const r = await approve(f.manager, bill);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain(`HT Hometech · 2026-06: remaining ${R(0)}, this bill ${R(0.01)}`);
    expect((await eventsFor(pool, bill))[0]!.lines).toEqual([expect.objectContaining({ kind: 'over', over: true, offSlice: false })]);
  });

  it('owner override with a reason: approved, event override', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await blankCc1('2026-07');
    const r = await approve(f.owner, bill, { budgetOverride: true, budgetReason: 'Shared overhead, allocated at month end' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((await billState(pool, bill)).status).toBe('approved');
    expect(await eventsFor(pool, bill)).toEqual([expect.objectContaining({ outcome: 'override', decided_by: f.owner })]);
  });

  it('a manager cannot override: 409 overrideRefused, the refused event recorded', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await blankCc1('2026-08');
    const r = await approve(f.manager, bill, { budgetOverride: true, budgetReason: 'I say so' });
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED', overrideRefused: true });
    expect((await billState(pool, bill)).status).toBe('draft');
    expect((await eventsFor(pool, bill)).map((e) => [e.outcome, e.decided_by])).toEqual([['refused', f.manager]]);
  });
});

describe('an account budgeted only in another month (the any-month test, blind review LOW)', () => {
  it('blank CC1 in a month with no row for the account: refused; FT in that month: "No budget", approved', async () => {
    await setPolicy(pool, f, 'block');
    const acct = crypto.randomUUID();
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
                      VALUES ($1, $2, 'BB-6500', 'Marketing', 'expense', 'debit', 3, true)`, [acct, f.co]);
    await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
                      VALUES ($1, $2, $3, '2026-03-01', 100, $4)`, [f.co, f.version, acct, f.cc.FT]);
    const blank = await makeBill(pool, f, [{ acct, amount: 50 }], { date: '2026-09-15' });
    const r = await approve(f.manager, blank);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toContain('BB-6500 Marketing · no cost centre 1 · 2026-09: not in a budgeted slice');
    const ft = await makeBill(pool, f, [{ acct, amount: 50, cc1: f.cc.FT }], { date: '2026-09-15' });
    expect((await approve(f.manager, ft)).statusCode).toBe(200);
    expect(await eventsFor(pool, ft)).toHaveLength(0);
  });
});

describe('warn', () => {
  it('UI without a reason: 400 BUDGET_REASON_REQUIRED, nothing written; with one: approved, event warn (kind off_slice)', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await blankCc1('2026-09');
    const r = await approve(f.manager, bill);
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.details).toMatchObject({ code: 'BUDGET_REASON_REQUIRED' });
    expect(r.body.error?.message).toContain('not in a budgeted slice');
    expect((await billState(pool, bill)).status).toBe('draft');
    expect(await eventsFor(pool, bill)).toHaveLength(0);
    const ok = await approve(f.manager, bill, { budgetReason: 'Shared cost' });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect((await billState(pool, bill)).status).toBe('approved');
    const [ev] = await eventsFor(pool, bill);
    expect(ev).toMatchObject({ outcome: 'warn', reason: 'Shared cost' });
    expect(ev!.lines).toEqual([expect.objectContaining({ kind: 'off_slice' })]);
  });
});

describe('off', () => {
  it('passes, no event', async () => {
    await setPolicy(pool, f, 'off');
    const bill = await blankCc1('2026-10');
    expect((await approve(f.manager, bill)).statusCode).toBe(200);
    expect(await eventsFor(pool, bill)).toHaveLength(0);
  });
});
