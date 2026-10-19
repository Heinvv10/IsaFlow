/**
 * G-06 review round 1: two concurrent RE-closes of a year whose close was reversed both walk to the
 * same free number (`YE-<year>-R1`). The unique index holds the ledger; the loser must hear "already
 * closed", not a raw 23505, and exactly one journal is written.
 *
 * The window is real but narrow, so it is opened deterministically, as k-046-year-end-squatter-race
 * does: the lookup of `YE-2025-R1` made by the walk returns null once (what the loser saw before the
 * winner committed) and everything later runs for real. The 23505 is NOT simulated: it comes from
 * `uq_gl_je_company_entry_number` on the fixture database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

let blinded = 0;
vi.mock('../../src/modules/accounting/services/gl/yearEndJournalPoster', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/modules/accounting/services/gl/yearEndJournalPoster')>();
  return {
    ...actual,
    findClosingJournal: async (companyId: string, entryNumber: string) => {
      if (entryNumber === 'YE-2025-R1' && blinded === 0) { blinded += 1; return null; }
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
const [revenue, bank, retained, period, reversedId, winnerId] = Array.from({ length: 6 }, () => crypto.randomUUID());

async function header(entry: string, number: string, source: string, reversedAt: string | null) {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at,reversed_at)
     VALUES($1,$2,$3,'2025-12-31',$4,'seed',$5,'posted',$6,$6,now(),$7)`,
    [entry, company, number, period, source, user, reversedAt]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g06race-${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [company, 'G06 reclose race']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'4000','Sales','revenue',NULL,'credit',true,false),
           ($3,$2,'1000','Bank','asset',NULL,'debit',true,false),
           ($4,$2,'3200','Retained Earnings','equity','retained_earnings','credit',true,true)`,
    [revenue, company, bank, retained]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2025',1,2025,'2025-01-01','2025-12-31','closed')`, [period, company]);
  clearSystemAccountCache(company);
  const sale = crypto.randomUUID();
  await header(sale, 'S-1', 'manual', null);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,500,0,'seed',$4),($1,$3,0,500,'seed',$4)`, [sale, bank, revenue, company]);
  // The first close, reversed; and the other caller's re-close, already committed.
  await header(reversedId, 'YE-2025', 'year_end', '2026-03-01T10:00:00Z');
  await pool.query('UPDATE gl_journal_entries SET reversed_by=$2 WHERE id=$1', [reversedId, user]);
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at,reversal_of_id)
     VALUES(gen_random_uuid(),$1,'JE-REV-1','2025-12-31',$2,'reversal','year_end','posted',$3,$3,now(),$4)`,
    [company, period, user, reversedId]);
  await header(winnerId, 'YE-2025-R1', 'year_end', null);
});

afterAll(async () => {
  try {
    clearSystemAccountCache(company);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id IS NOT NULL', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('a re-close that loses the race for YE-<year>-R<n>', () => {
  it('is told the year is already closed by the winner, and writes nothing', async () => {
    const result = await closeFiscalYear(company, '2025', user) as
      { alreadyClosed: boolean; closingEntry: { id: string; entry_number: string } };
    expect(blinded).toBe(1);
    expect(result.alreadyClosed).toBe(true);
    expect(result.closingEntry.id).toBe(winnerId);
    expect(result.closingEntry.entry_number).toBe('YE-2025-R1');

    const closes = await pool.query(
      "SELECT entry_number FROM gl_journal_entries WHERE company_id=$1 AND source='year_end' ORDER BY entry_number", [company]);
    expect(closes.rows.map((r) => r.entry_number)).toEqual(['JE-REV-1', 'YE-2025', 'YE-2025-R1']);
    // The losing transaction rolled back whole, locks included.
    const periods = await pool.query('SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1', [company]);
    expect(periods.rows.map((r) => r.status)).toEqual(['closed']);
  });
});
