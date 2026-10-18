/**
 * G-06 review: the two ways the re-close walk can refuse come back as TYPED results from the real
 * close, before any write, instead of a thrown Error (a 500 on the route, a retried tool call over MCP).
 *
 *  - a year closed and reversed more than 25 times: `too_many_recloses`;
 *  - a close whose reversal chain is longer than the walk will read (20 links): `closing_chain_unreadable`,
 *    which used to be read as "standing" past the cap and so could post a second close over a flat P&L.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
interface T { company: string; revenue: string; bank: string; retained: string; period: string }
const mk = (): T => ({ company: crypto.randomUUID(), revenue: crypto.randomUUID(), bank: crypto.randomUUID(), retained: crypto.randomUUID(), period: crypto.randomUUID() });
const many = mk();
const long = mk();

async function seed(t: T, name: string) {
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [t.company, name]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'4000','Sales','revenue',NULL,'credit',true,false),
           ($3,$2,'1000','Bank','asset',NULL,'debit',true,false),
           ($4,$2,'3200','Retained Earnings','equity','retained_earnings','credit',true,true)`,
    [t.revenue, t.company, t.bank, t.retained]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2025',1,2025,'2025-01-01','2025-12-31','closed')`, [t.period, t.company]);
  clearSystemAccountCache(t.company);
  const sale = crypto.randomUUID();
  await header(t, sale, 'S-1', 'manual', null, null);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,500,0,'seed',$4),($1,$3,0,500,'seed',$4)`, [sale, t.bank, t.revenue, t.company]);
}

async function header(t: T, id: string, number: string, source: string, reversedAt: string | null, reversalOf: string | null) {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at,reversed_at,reversal_of_id)
     VALUES($1,$2,$3,'2025-12-31',$4,'seed',$5,'posted',$6,$6,now(),$7,$8)`,
    [id, t.company, number, t.period, source, user, reversedAt, reversalOf]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g06lim-${user}@test.local`]);
  await seed(many, 'G06 many recloses');
  await seed(long, 'G06 long chain');
  // 26 closes, each reversed by its own contra: YE-2025, YE-2025-R1 .. YE-2025-R25.
  for (let i = 0; i <= 25; i += 1) {
    const close = crypto.randomUUID();
    await header(many, close, i === 0 ? 'YE-2025' : `YE-2025-R${i}`, 'year_end', '2026-03-01T10:00:00Z', null);
    await header(many, crypto.randomUUID(), `REV-${i}`, 'year_end', null, close);
  }
  // One close, reversed, then the reversal reversed, and so on 22 links deep.
  let previous = crypto.randomUUID();
  await header(long, previous, 'YE-2025', 'year_end', '2026-03-01T10:00:00Z', null);
  for (let i = 1; i <= 22; i += 1) {
    const next = crypto.randomUUID();
    await header(long, next, `LINK-${i}`, 'year_end', i < 22 ? '2026-03-01T10:00:00Z' : null, previous);
    previous = next;
  }
});

afterAll(async () => {
  try {
    for (const t of [many, long]) {
      clearSystemAccountCache(t.company);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)', [t.company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id IS NOT NULL', [t.company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [t.company]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('the re-close walk refuses with a typed result', () => {
  it('a year closed and reversed more than 25 times', async () => {
    const result = await closeFiscalYear(many.company, '2025', user);
    expect(result).toMatchObject({ error: 'too_many_recloses', code: 'YEAR_END_TOO_MANY_RECLOSES', entryNumber: 'YE-2025' });
    const dry = await closeFiscalYear(many.company, '2025', user, { dryRun: true });
    expect(dry).toMatchObject({ error: 'too_many_recloses' });
  });

  it('a close whose reversal chain is too long to read', async () => {
    const result = await closeFiscalYear(long.company, '2025', user);
    expect(result).toMatchObject({ error: 'closing_chain_unreadable', code: 'YEAR_END_CLOSE_CHAIN_TOO_LONG', entryNumber: 'YE-2025' });
  });

  it('wrote nothing and locked nothing', async () => {
    for (const t of [many, long]) {
      const periods = await pool.query('SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1', [t.company]);
      expect(periods.rows.map((r) => r.status)).toEqual(['closed']);
    }
    const n = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [many.company]);
    expect(n.rows[0].n).toBe(52);
  });
});
