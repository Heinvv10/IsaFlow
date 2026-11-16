/**
 * Forensic-controls step 4 — automatic snapshots: an "unchanged" reference
 * covers the AR ageing and control totals, not the GL only. Split out of
 * audit-snapshots-auto.int.test.ts (300-line cap), same harness: one company
 * per case, members with signed tokens, closes through the real route.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fiscalPeriodsAction from '../../pages/api/accounting/fiscal-periods-action';
import vatPeriodLocks from '../../pages/api/accounting/vat-period-locks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { members, newCompany } from './entity-changes.helpers';
import { SNAPSHOT_WAIT_MS, cleanupAudit, plantFiscalYear, plantJournal, plantLedger, waitForSnapshots } from './audit-snapshots.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '';
const KEY = 'a'.repeat(48);

beforeAll(async () => {
  [o] = await members(pool, tokens, 1);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = KEY;
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'auto-test';
});
afterEach(() => { process.env.AUDIT_SNAPSHOT_SIGNING_KEY = KEY; });
afterAll(() => cleanupAudit(pool, companies, [o]));

async function company() {
  const c = await newCompany(pool, [[o, 'owner']], companies);
  await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [c]);
  const l = await plantLedger(pool, c);
  const periods = await plantFiscalYear(pool, c, 2026, '2026-01-01');
  await plantJournal(pool, c, { date: '2026-01-15', amount: 100, debit: l.bank, credit: l.sales, by: o });
  return { c, l, periods };
}
const action = (user: string, c: string, body: Record<string, unknown>) =>
  callRoute(fiscalPeriodsAction, tokens[user]!, c, 'POST', { ...body, confirm: true }, '/api/accounting/fiscal-periods-action');

describe('automatic snapshots: what "unchanged" covers', { timeout: 3 * SNAPSHOT_WAIT_MS }, () => {
  it('unchanged covers the ageing and control totals, not the GL only; a reference still freezes its own checks', async () => {
    const { c, l, periods } = await company();
    const cycle = async (n: number) => {
      expect((await action(o, c, { action: 'close', id: periods[0] })).state.statusCode).toBe(200);
      const all = await waitForSnapshots(pool, c, n);
      expect((await action(o, c, { action: 'reopen', id: periods[0] })).state.statusCode).toBe(200);
      return all;
    };
    await cycle(1);
    // A bank line moves no journal and no total: a reference, whose own check run sees the line (the anomaly scan).
    // Excluded, so the period still passes its close checks (every close is gated since 2026-11-15).
    await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
                      VALUES ($1, $2, DATE '2026-01-20', 777, 'unposted statement line', 'excluded')`, [c, l.bank]);
    const two = await cycle(2);
    expect(two.map((x) => x.status)).toEqual(['sealed', 'unchanged']);
    const population = async (run: unknown) => (await pool.query(
      `SELECT population FROM audit_check_results WHERE run_id = $1 AND check_id = 'anomaly.statistical_outliers'`, [run])).rows[0].population;
    expect([await population(two[0]!.check_run_id), await population(two[1]!.check_run_id)]).toEqual([0, 1]);
    // An invoice moves no journal either, but it moves the AR ageing: a new sealed copy. The period
    // close and lock checks refuse a period whose AR does not tie to the GL (no AR control account
    // here), so the period is closed first (nothing moved: unchanged) and a VAT lock at the same
    // cutoff, which runs no close checks, takes the snapshot after the invoice.
    expect((await action(o, c, { action: 'close', id: periods[0] })).state.statusCode).toBe(200);
    expect((await waitForSnapshots(pool, c, 3)).map((x) => x.status)).toEqual(['sealed', 'unchanged', 'unchanged']);
    const customer = crypto.randomUUID();
    await pool.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Ageing customer')`, [customer, c]);
    await pool.query(`INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status,
                        total_amount, amount_paid, created_by)
                      VALUES ($1, $2, $2, 'AGE-1', DATE '2026-01-10', DATE '2026-01-20', 'sent', 500, 0, $3)`, [c, customer, o]);
    const vat = await callRoute(vatPeriodLocks, tokens[o]!, c, 'POST',
      { action: 'lock', periodStart: '2026-01-01', periodEnd: '2026-01-31' }, '/api/accounting/vat-period-locks');
    expect(vat.state.statusCode, JSON.stringify(vat.state.body)).toBe(200);
    expect((await waitForSnapshots(pool, c, 4)).map((x) => x.status)).toEqual(['sealed', 'unchanged', 'unchanged', 'sealed']);
  });
});
