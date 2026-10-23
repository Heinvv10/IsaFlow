/**
 * Adversarial repros for the change of financial year end. Synthetic data only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange, YearEndChangeRefusedError } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { undoYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { closeYear } from '@/modules/accounting/services/gl/fiscalPeriodService';

import { assertDisposable } from './mfa-impersonation-postgres.helpers';


assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const made: string[] = [];
const users: string[] = [user];
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [id]);
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    for (const u of users) await pool.query('DELETE FROM users WHERE id = $1', [u]);
  } finally { await pool.end(); }
}, 60000);

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: user, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function company(fyStart: number, dates: string[]) {
  if (made.length === 0) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  }
  const id = crypto.randomUUID();
  made.push(id);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BRK co', $2)`, [id, fyStart]);
  const bank = crypto.randomUUID(), sales = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'C-1', 'bank', 'asset', 'debit', 3, true), ($2, $3, 'C-4', 'sales', 'revenue', 'credit', 3, true)`,
    [bank, sales, id]);
  for (const d of dates) await inTx(id, () => generateFiscalYearForDate(id, d));
  return { id, bank, sales };
}

async function post(c: { id: string; bank: string; sales: string }, date: string, amount: number) {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
     VALUES ($1, $2, $3, 'sale', 'draft', 'manual') RETURNING id, fiscal_period_id`, [c.id, date, user])).rows[0];
  await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
                    VALUES ($1, $2, $3, $5, 0, 'd'), ($1, $2, $4, 0, $5, 'c')`, [je.id, c.id, c.bank, c.sales, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [je.id, user]);
  return je as { id: string; fiscal_period_id: string };
}

const refusalOf = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { if (e instanceof YearEndChangeRefusedError) return e.message; throw e; }
};
const changes = async (id: string) => (await pool.query(
  `SELECT from_end_date::text f, to_end_date::text t, (applied_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS filed, reversed_at IS NOT NULL AS rev
     FROM fiscal_year_end_changes WHERE company_id = $1 ORDER BY applied_at`, [id])).rows;

// ── Law ──────────────────────────────────────────────────────────────────────
import { assessYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeService';

const invariants = async (id: string) => (await pool.query(
  `SELECT
     (SELECT COUNT(*)::int FROM gl_journal_entries je JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
       WHERE je.company_id = $1 AND je.entry_date NOT BETWEEN fp.start_date AND fp.end_date) AS je_outside,
     (SELECT COUNT(*)::int FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
       WHERE fp.company_id = $1 AND (fp.start_date < fy.start_date OR fp.end_date > fy.end_date OR fp.fiscal_year <> fy.fiscal_year)) AS p_outside,
     (SELECT COUNT(*)::int FROM (SELECT start_date, lag(end_date) OVER (ORDER BY start_date) pe FROM fiscal_years WHERE company_id = $1) x
       WHERE pe IS NOT NULL AND start_date <> pe + 1) AS year_gaps,
     (SELECT COUNT(*)::int FROM (SELECT start_date, count(*) c FROM fiscal_periods WHERE company_id = $1 GROUP BY 1) x WHERE c > 1) AS dup_periods`,
  [id])).rows[0];

describe('R3: undo exactness', () => {
  // updated_at records the undo itself (decided: the rows did change twice); everything else is exact.
  it('R3-1: undo restores every fiscal_years and fiscal_periods row byte for byte, updated_at aside', async () => {
    const c = await company(1, ['2026-03-01', '2027-03-01']);
    await post(c, '2027-02-03', 30);
    const dump = async () => ({
      years: (await pool.query(`SELECT (to_jsonb(fy) - 'updated_at')::text j FROM fiscal_years fy WHERE company_id = $1 ORDER BY start_date`, [c.id])).rows.map((r) => r.j),
      periods: (await pool.query(`SELECT (to_jsonb(fp) - 'updated_at')::text j FROM fiscal_periods fp WHERE company_id = $1 ORDER BY start_date`, [c.id])).rows.map((r) => r.j),
    });
    const before = await dump();
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, expectedEndDate: '2027-02-28', ...OK }, TODAY));
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'filed with CIPC in error'));
    const after = await dump();
    const diff = (a: string[], b: string[]) => a.map((x, i) => [x, b[i]]).filter(([x, y]) => x !== y)
      .map(([x, y]) => Object.entries(JSON.parse(x!)).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(JSON.parse(y ?? '{}')[k])).map(([k, v]) => `${JSON.parse(x!).start_date} ${k}: ${String(v)} -> ${String(JSON.parse(y ?? '{}')[k])}`));
    expect({ years: diff(before.years, after.years), periods: diff(before.periods, after.periods) }).toEqual({ years: [], periods: [] });
  });

  it('R3-2: undo change 1 after change 2 applied+undone leaves every invariant and the pre-change layout', async () => {
    const c = await company(3, ['2026-03-01']);
    const layout = async () => (await pool.query(
      `SELECT fiscal_year, start_date::text s, end_date::text e, kind FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`, [c.id])).rows;
    const before = await layout();
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 5, kind: 'extend', expectedEndDate: '2027-05-31', ...OK }, TODAY));
    await post(c, '2027-08-10', 40); // into the year change 1 built (FY2028 Jun27-May28)
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, expectedEndDate: '2028-02-29', ...OK }, '2027-07-01'));
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'second change in error'));
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'first change in error too'));
    expect(await invariants(c.id)).toEqual({ je_outside: 0, p_outside: 0, year_gaps: 0, dup_periods: 0 });
    expect((await layout()).slice(0, before.length)).toEqual(before);
    expect((await pool.query('SELECT financial_year_start FROM companies WHERE id = $1', [c.id])).rows[0].financial_year_start).toBe(3);
  });
});

describe('R3: what is applied is what was previewed', () => {
  it('R3-3: the preview the user confirmed is not the change that is applied a day later', async () => {
    const c = await company(3, ['2026-03-01']);
    const previewDay = '2027-02-27', applyDay = '2027-03-01';
    const p = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 5 }, previewDay));
    expect(p.chosen).toMatchObject({ endDate: '2027-05-31', months: 15 });
    // The wizard POSTs only { newYearEndMonth, kind, reason, confirmations } (StepConfirm.tsx).
    const r = await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 5, kind: p.chosen!.kind, expectedEndDate: p.chosen!.endDate, ...OK }, applyDay)));
    const applied = (await pool.query(`SELECT transition_start::text s, to_end_date::text t, months FROM fiscal_year_end_changes WHERE company_id = $1`, [c.id])).rows;
    expect({ refusal: r, applied }, 'apply must refuse when the transition differs from the confirmed preview')
      .toEqual({ refusal: expect.any(String), applied: [] });
  });
});

describe('R3: actor check', () => {
  it('R3-4 (informational): an app_user session naming an owner in request.jwt.claims passes the owner/admin trigger', async () => {
    const c = await company(3, ['2026-03-01']);
    const owner = crypto.randomUUID();
    users.push(owner);
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [owner, `${owner}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [c.id, owner]);
    const yearId = (await pool.query(`SELECT id FROM fiscal_years WHERE company_id = $1`, [c.id])).rows[0].id;
    const client = await pool.connect();
    let err: unknown = null;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c.id]);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(
        `INSERT INTO fiscal_year_end_changes (company_id, fiscal_year_id, from_start_month, to_start_month, transition_start,
           from_end_date, to_end_date, months, reason, cipc_filed_confirmed, sars_notified_confirmed, applied_by)
         VALUES ($1, $2, 3, 1, '2026-03-01', '2027-02-28', '2026-12-31', 10, 'record without the change', true, true, $3)`, [c.id, yearId, owner]);
      await client.query('ROLLBACK');
    } catch (e) { err = e; await client.query('ROLLBACK'); } finally { client.release(); }
    expect(String(err)).toBe('null'); // documents the limit: the check is only as strong as the GUC
  });
});
