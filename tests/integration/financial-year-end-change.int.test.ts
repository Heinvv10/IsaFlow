/**
 * Change of financial year end (Feature B) and its undo (Feature G), on real
 * PostgreSQL, through the services with a fixed "today" (2026-10-23) so the
 * Companies Act s27(4)(b) "later than the filing date" rule is deterministic.
 * The route's RBAC/CSRF/refusal envelope: financial-year-end-change-route.int.test.ts.
 * All data synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { assessYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeService';
import { applyYearEndChange, YearEndChangeRefusedError } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { undoYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const made: string[] = [];
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
      // Deleting posted lines re-computes their balance rows: clear them again.
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [id]);
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
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

/** A company on fyStart with stored years generated for each date, and two accounts. */
async function company(fyStart: number, dates: string[]) {
  if (made.length === 0) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  }
  const id = crypto.randomUUID();
  made.push(id);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYCHG co', $2)`, [id, fyStart]);
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

const years = async (id: string) => (await pool.query(
  `SELECT fiscal_year, start_date::text s, end_date::text e, kind,
          (SELECT COUNT(*)::int FROM fiscal_periods fp WHERE fp.fiscal_year_id = fy.id) AS periods
     FROM fiscal_years fy WHERE company_id = $1 ORDER BY start_date`, [id])).rows;
const periodsDump = async (id: string) => (await pool.query(
  `SELECT id, fiscal_year_id, fiscal_year, period_number, period_name, start_date::text, end_date::text, status, closed_by, closed_at, created_at
     FROM fiscal_periods WHERE company_id = $1 ORDER BY start_date`, [id])).rows;
const yearsDump = async (id: string) => (await pool.query(
  `SELECT id, fiscal_year, start_date::text, end_date::text, status, kind, change_id, created_at FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`, [id])).rows;
const tb = async (id: string) => (await pool.query(
  `SELECT jl.gl_account_id, je.fiscal_period_id, SUM(jl.debit - jl.credit)::numeric AS net
     FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = $1 AND je.status = 'posted' GROUP BY 1, 2 ORDER BY 1, 2`, [id])).rows;
const refusalOf = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { if (e instanceof YearEndChangeRefusedError) return e.message; throw e; }
};

describe('stretch: December to February (14-month transition year)', () => {
  it('previews, applies, and leaves posted journals and closed months untouched', async () => {
    const c = await company(1, ['2026-03-01', '2027-03-01']);
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-03-01'`, [c.id]);
    const march = await post(c, '2026-03-10', 100); // in a closed month (posted before closing in real life)
    const jan27 = await post(c, '2027-01-15', 250);

    const preview = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 2 }, TODAY));
    expect(preview.refusals).toEqual([]);
    expect(preview.chosen).toMatchObject({ kind: 'extend', endDate: '2027-02-28', months: 14, newStartMonth: 3, nextYearStart: '2027-03-01' });

    const r = await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    expect(r).toMatchObject({ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', months: 14 });

    expect((await years(c.id)).map((y) => [y.fiscal_year, y.s, y.e, y.kind, y.periods])).toEqual([
      [2026, '2026-01-01', '2027-02-28', 'transition', 14],
      [2028, '2027-03-01', '2028-02-29', 'normal', 12],
    ]);
    const p = (await pool.query(
      `SELECT start_date::text s, fiscal_year, period_number FROM fiscal_periods WHERE company_id = $1 AND start_date IN ('2027-01-01','2027-02-01','2027-03-01') ORDER BY 1`, [c.id])).rows;
    expect(p).toEqual([{ s: '2027-01-01', fiscal_year: 2026, period_number: 13 }, { s: '2027-02-01', fiscal_year: 2026, period_number: 14 },
      { s: '2027-03-01', fiscal_year: 2028, period_number: 1 }]);
    const after = (await pool.query('SELECT id, entry_date::text d, fiscal_period_id FROM gl_journal_entries WHERE id = ANY($1) ORDER BY d', [[march.id, jan27.id]])).rows;
    expect(after).toEqual([{ id: march.id, d: '2026-03-10', fiscal_period_id: march.fiscal_period_id }, { id: jan27.id, d: '2027-01-15', fiscal_period_id: jan27.fiscal_period_id }]);
    expect((await pool.query('SELECT financial_year_start FROM companies WHERE id = $1', [c.id])).rows[0].financial_year_start).toBe(3);
    const rec = (await pool.query('SELECT from_end_date::text f, to_end_date::text t, months, reason FROM fiscal_year_end_changes WHERE company_id = $1', [c.id])).rows;
    expect(rec).toEqual([{ f: '2026-12-31', t: '2027-02-28', months: 14, reason: OK.reason }]);
    const audit = (await pool.query(`SELECT action, entity_type FROM audit_log WHERE company_id = $1`, [c.id])).rows;
    expect(audit).toEqual([{ action: 'update', entity_type: 'fiscal_year_end_change' }]);

    // s27(4)(a): a second change during the same financial year is refused.
    const again = await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 1, ...OK }, TODAY)));
    expect(again).toMatch(/s27\(4\)\(a\)/);
  });
});

describe('undo', () => {
  it('restores the periods byte for byte and leaves the trial balance unchanged', async () => {
    const c = await company(1, ['2026-03-01', '2027-03-01']);
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date <= '2026-06-01'`, [c.id]);
    await post(c, '2026-05-10', 70);
    await post(c, '2027-02-03', 30);
    const before = { periods: await periodsDump(c.id), years: await yearsDump(c.id), tb: await tb(c.id) };

    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    expect(await periodsDump(c.id)).not.toEqual(before.periods);
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed with CIPC in error'));

    expect(await periodsDump(c.id)).toEqual(before.periods);
    expect(await yearsDump(c.id)).toEqual(before.years);
    expect(await tb(c.id)).toEqual(before.tb);
    expect((await pool.query('SELECT financial_year_start FROM companies WHERE id = $1', [c.id])).rows[0].financial_year_start).toBe(1);
    const rec = (await pool.query('SELECT reversed_at IS NOT NULL AS r FROM fiscal_year_end_changes WHERE company_id = $1', [c.id])).rows;
    expect(rec).toEqual([{ r: true }]);
    expect((await pool.query(`SELECT action FROM audit_log WHERE company_id = $1 ORDER BY created_at`, [c.id])).rows.map((r) => r.action))
      .toEqual(['update', 'reverse']);
  });

  it('is refused once a period beyond the original year end has been closed', async () => {
    const c = await company(1, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2027-01-01'`, [c.id]);
    const r = await refusalOf(inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed with CIPC in error')));
    expect(r).toMatch(/January 2027.*no longer be undone/);
  });

  it('a change record cannot be rewritten or deleted', async () => {
    const c = await company(1, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    const id = c.id;
    const e1 = await pool.query(`UPDATE fiscal_year_end_changes SET reason = 'rewritten history here' WHERE company_id = $1`, [id]).catch((e) => e);
    expect(String(e1)).toMatch(/only be marked reversed/);
    const e2 = await pool.query(`DELETE FROM fiscal_year_end_changes WHERE company_id = $1`, [id]).catch((e) => e);
    expect(String(e2)).toMatch(/cannot be deleted/);
    const e3 = await pool.query(`UPDATE fiscal_year_end_changes SET fiscal_year_id = NULL WHERE company_id = $1`, [id]).catch((e) => e);
    expect(String(e3)).toMatch(/only be marked reversed/);
  });
});

describe('undo refusals', () => {
  it('refuses (409, not a 500) once the shortened transition year is itself closed', async () => {
    const c = await company(1, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY));
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date <= '2026-11-01'`, [c.id]);
    expect(await refusalOf(inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed with CIPC in error'))))
      .toMatch(/transition year is closed/);
  });

  it('refuses when the transition year has a year-end journal, and a second undo finds nothing to undo', async () => {
    const c = await company(1, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    const ye = (await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
                                   VALUES ($1, '2027-02-28', $2, 'YE', 'draft', 'year_end') RETURNING id`, [c.id, user])).rows[0].id;
    expect(await refusalOf(inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed with CIPC in error')))).toMatch(/year-end closing journal/);
    await pool.query('DELETE FROM gl_journal_entries WHERE id = $1', [ye]);
    await inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed with CIPC in error'));
    expect(await refusalOf(inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed with CIPC in error')))).toMatch(/no change of financial year end to undo/);
  });
});

describe('a month that allows both a shorter and a longer year', () => {
  it('asks which, and applies the one chosen', async () => {
    const c = await company(1, ['2026-03-01']);
    const a = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 2 }, '2026-01-10'));
    expect(a.options.map((o) => o.kind)).toEqual(['shorten', 'extend']);
    expect(a.refusals.join(' ')).toMatch(/choose one/);
    const r = await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, kind: 'shorten', ...OK }, '2026-01-10'));
    expect(r).toMatchObject({ endDate: '2026-02-28', months: 2 });
  });
});

describe('shrink and refusals', () => {
  it('shrinks December to November: December moves into the next year as its period 1', async () => {
    const c = await company(1, ['2026-03-01']);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY));
    expect((await years(c.id)).map((y) => [y.fiscal_year, y.s, y.e, y.kind, y.periods])).toEqual([
      [2026, '2026-01-01', '2026-11-30', 'transition', 11],
      [2027, '2026-12-01', '2027-11-30', 'normal', 12],
    ]);
    expect((await pool.query(`SELECT fiscal_year, period_number FROM fiscal_periods WHERE company_id = $1 AND start_date = '2026-12-01'`, [c.id])).rows[0])
      .toEqual({ fiscal_year: 2027, period_number: 1 });
  });

  it('refuses when a period that would move is closed', async () => {
    const c = await company(1, ['2026-03-01']);
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-12-01'`, [c.id]);
    const r = await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 11, ...OK }, TODAY)));
    expect(r).toMatch(/December 2026.*closed and locked periods never move/);
  });

  it('refuses a year end already passed (s27(4)(b)) and one beyond 15 months (s27(4)(c))', async () => {
    const c = await company(1, ['2026-03-01']);
    const a = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 4 }, TODAY));
    expect(a.options).toEqual([]);
    expect(a.refusals.join(' ')).toMatch(/2026-04-30 has already passed.*s27\(4\)\(b\)/);
    expect(a.refusals.join(' ')).toMatch(/2027-04-30.*longer than 15 months.*s27\(4\)\(c\)/);
  });

  it('refuses a year that already has a year-end journal, and missing confirmations', async () => {
    const c = await company(1, ['2026-03-01']);
    expect(await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK, sarsNotifiedConfirmed: false }, TODAY))))
      .toMatch(/SARS/);
    await pool.query(`INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
                      VALUES ($1, '2026-12-31', $2, 'YE', 'draft', 'year_end')`, [c.id, user]);
    expect(await refusalOf(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY))))
      .toMatch(/year-end closing journal/);
  });

  it('moves a company on legacy January-December periods (declared March) to a real year end', async () => {
    const c = await company(3, []);
    await pool.query(
      `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
       SELECT $1, TO_CHAR(MAKE_DATE(yr, m, 1), 'FMMonth YYYY'), m, yr, MAKE_DATE(yr, m, 1),
              (MAKE_DATE(yr, m, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date
         FROM generate_series(2026, 2027) yr, generate_series(1, 12) m`, [c.id]);
    const r = await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 12, ...OK }, TODAY));
    expect(r).toMatchObject({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2026-12-31', months: 10 });
    const ys = (await years(c.id)).map((y) => [y.fiscal_year, y.s, y.e, y.kind]);
    expect(ys).toContainEqual([2027, '2026-03-01', '2026-12-31', 'transition']);
    expect(ys).toContainEqual([2028, '2027-01-01', '2027-12-31', 'normal']);
    expect((await pool.query(`SELECT fiscal_year, period_number FROM fiscal_periods WHERE company_id = $1 AND start_date = '2027-01-01'`, [c.id])).rows[0])
      .toEqual({ fiscal_year: 2028, period_number: 1 });
  });
});
