/**
 * A squatter that takes `YE-<year>` BETWEEN the pre-INSERT lookup and the
 * INSERT itself.
 *
 * The pre-INSERT lookup refuses a squatter by name (`closing_entry_number_taken`)
 * — but it is a separate statement from the write, and a row that appears in
 * that window reaches the real unique index instead. That case used to rethrow
 * the raw 23505, which the route answers as HTTP 500 "Failed to process
 * year-end": the exact opacity the typed refusal exists to remove, differing
 * from the refused case only in timing.
 *
 * The window is real but narrow, so it is opened deterministically: the first
 * `findClosingJournal` returns null (what a caller sees before the squatter
 * commits) and every later one runs for real. The 23505 is NOT simulated — it
 * comes from `uq_gl_je_company_entry_number` on the fixture database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

let lookups = 0;
vi.mock('../../src/modules/accounting/services/gl/yearEndJournalPoster', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/modules/accounting/services/gl/yearEndJournalPoster')>();
  return {
    ...actual,
    findClosingJournal: async (companyId: string, entryNumber: string) => {
      lookups += 1;
      // Only the pre-INSERT read is blinded. The re-read in the catch — the one
      // that decides what the caller is told — runs against the real table.
      if (lookups === 1) return null;
      return actual.findClosingJournal(companyId, entryNumber);
    },
  };
});

import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const company = crypto.randomUUID();
const revenue = crypto.randomUUID();
const bank = crypto.randomUUID();
const retained = crypto.randomUUID();
const period = crypto.randomUUID();
let squatterId = '';

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `k046race-${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)',
    [company, 'K046 late squatter']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'4000','Sales','revenue',NULL,'credit',true,false),
           ($3,$2,'1000','Bank','asset',NULL,'debit',true,false),
           ($4,$2,'3200','Retained Earnings','equity','retained_earnings','credit',true,true)`,
    [revenue, company, bank, retained]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2026',1,2026,'2026-01-01','2026-12-31','closed')`,
    [period, company]);
  clearSystemAccountCache(company);

  // Real P&L, so the close has a journal to write and genuinely reaches the
  // INSERT rather than short-circuiting as a dormant year.
  const sale = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,'S-1','2026-06-30',$3,'seed','manual','posted',$4,$4,now())`,
    [sale, company, period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,500,0,'seed',$4),($1,$3,0,500,'seed',$4)`,
    [sale, bank, revenue, company]);

  // The squatter. It is in the table the whole time; the blinded first lookup
  // is what makes the close meet it at the index instead of at the guard.
  squatterId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,'YE-2026','2026-06-30',$3,'not a close','manual','posted',$4,$4,now())`,
    [squatterId, company, period, user]);
});

afterAll(async () => {
  try {
    clearSystemAccountCache(company);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query(
      'DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)',
      [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('a squatter that takes the number after the guard has already looked', () => {
  it('is named by the same typed refusal, not answered as a raw 23505', async () => {
    const result = await closeFiscalYear(company, '2026', user) as
      { error: string; entryId: string; source: string; status: string; entryNumber: string };

    expect(lookups).toBeGreaterThan(1);      // the catch's re-read really ran
    expect(result.error).toBe('closing_entry_number_taken');
    expect(result.entryId).toBe(squatterId);
    expect(result.source).toBe('manual');
    expect(result.entryNumber).toBe('YE-2026');

    // The losing transaction rolled back whole: no close, and — the half that
    // cannot be undone — no locked periods.
    const closes = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",
      [company]);
    expect(closes.rows[0].n).toBe(0);
    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1', [company]);
    expect(periods.rows.map((r) => r.status)).toEqual(['closed']);
  });
});
