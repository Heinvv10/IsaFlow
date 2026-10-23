/**
 * Feature C: the year-end close of a year that is not twelve months long. A
 * 14-month transition year (made by the real change-of-year-end service) and a
 * 6-month short year both close end to end: the YE journal is dated at the
 * transition end, rolls exactly that year's result into retained earnings, and
 * every period of the year (13 and 14 included) ends locked.
 * Real PostgreSQL; all data synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndCloseService';
import { closePeriod } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const user = crypto.randomUUID();
const made: string[] = [];

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
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

interface Co { id: string; sales: string; rent: string; bank: string; re: string }

async function company(fyStart: number): Promise<Co> {
  if (made.length === 0) await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  const c: Co = { id: crypto.randomUUID(), sales: crypto.randomUUID(), rent: crypto.randomUUID(), bank: crypto.randomUUID(), re: crypto.randomUUID() };
  made.push(c.id);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYCLOSE co', $2)`, [c.id, fyStart]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1, $5, '4000', 'Sales', 'revenue', NULL, 'credit', true, false), ($2, $5, '5000', 'Rent', 'expense', NULL, 'debit', true, false),
            ($3, $5, '1000', 'Bank', 'asset', NULL, 'debit', true, false), ($4, $5, '3200', 'Retained Earnings', 'equity', 'retained_earnings', 'credit', true, true)`,
    [c.sales, c.rent, c.bank, c.re, c.id]);
  clearSystemAccountCache(c.id);
  return c;
}

async function post(c: Co, date: string, debit: string, credit: string, amount: number) {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
     VALUES ($1, $2, $3, 'seed', 'draft', 'manual') RETURNING id`, [c.id, date, user])).rows[0];
  await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
                    VALUES ($1, $2, $3, $5, 0, 'd'), ($1, $2, $4, 0, $5, 'c')`, [je.id, c.id, debit, credit, amount]);
  await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [je.id, user]);
}

/** Close every period of a label in order, through the real service (13, 14 after 12). */
async function closeAll(c: Co, label: number) {
  const ids = (await pool.query('SELECT id FROM fiscal_periods WHERE company_id = $1 AND fiscal_year = $2 ORDER BY period_number', [c.id, label])).rows;
  for (const { id } of ids) await inTx(c.id, () => closePeriod(c.id, id, user));
}

const ye = async (c: Co) => (await pool.query(
  `SELECT je.entry_date::text d, SUM(jl.credit - jl.debit) FILTER (WHERE jl.gl_account_id = $2)::numeric AS re
     FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.company_id = $1 AND je.source = 'year_end' GROUP BY 1`, [c.id, c.re])).rows;
const statuses = async (c: Co, label: number) => (await pool.query(
  `SELECT status, COUNT(*)::int n, MAX(period_number) maxn FROM fiscal_periods WHERE company_id = $1 AND fiscal_year = $2 GROUP BY 1`, [c.id, label])).rows;

describe('year-end close of a non-12-month year', () => {
  it('closes a 14-month transition year: YE dated 28 Feb 2027, its whole result to RE, 14 periods locked', async () => {
    const c = await company(1);
    await inTx(c.id, () => generateFiscalYearForDate(c.id, '2026-05-01'));
    await inTx(c.id, () => applyYearEndChange(c.id, user, {
      newYearEndMonth: 2, reason: 'Align with the group year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true,
    }, '2026-10-23'));
    await post(c, '2026-01-20', c.bank, c.sales, 1000);
    await post(c, '2027-02-10', c.bank, c.sales, 500);   // month 14
    await post(c, '2026-07-01', c.rent, c.bank, 300);
    await post(c, '2027-03-05', c.bank, c.sales, 9999);  // next year: must stay out
    await closeAll(c, 2026);

    const r = await inTx(c.id, () => closeFiscalYear(c.id, '2026', user));
    expect('error' in r ? r : null).toBeNull();
    expect(await ye(c)).toEqual([{ d: '2027-02-28', re: '1200.00' }]);
    expect(await statuses(c, 2026)).toEqual([{ status: 'locked', n: 14, maxn: 14 }]);
    const y = (await pool.query(`SELECT status FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2026`, [c.id])).rows[0];
    expect(y.status).toBe('locked');
  });

  it('closes a 6-month short year', async () => {
    const c = await company(7);
    const id = (await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
      VALUES ($1, 2025, '2025-01-01', '2025-06-30', 'transition') RETURNING id`, [c.id])).rows[0].id;
    await pool.query('SELECT public.fiscal_periods_generate($1)', [id]);
    await post(c, '2025-03-03', c.bank, c.sales, 700);
    await post(c, '2025-05-05', c.rent, c.bank, 200);
    await closeAll(c, 2025);
    const r = await inTx(c.id, () => closeFiscalYear(c.id, '2025', user));
    expect('error' in r ? r : null).toBeNull();
    expect(await ye(c)).toEqual([{ d: '2025-06-30', re: '500.00' }]);
    expect(await statuses(c, 2025)).toEqual([{ status: 'locked', n: 6, maxn: 6 }]);
  });

  it('closePeriod still demands the earlier periods first, period 13 after 12', async () => {
    const c = await company(1);
    await inTx(c.id, () => generateFiscalYearForDate(c.id, '2026-05-01'));
    await inTx(c.id, () => applyYearEndChange(c.id, user, {
      newYearEndMonth: 2, reason: 'Align with the group year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true,
    }, '2026-10-23'));
    const p13 = (await pool.query('SELECT id FROM fiscal_periods WHERE company_id = $1 AND fiscal_year = 2026 AND period_number = 13', [c.id])).rows[0].id;
    await expect(inTx(c.id, () => closePeriod(c.id, p13, user))).rejects.toThrow(/prior periods are still open/);
  });
});
