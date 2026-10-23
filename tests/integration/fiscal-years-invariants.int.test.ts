/**
 * Financial years as stored records (migration 940) and journal periods
 * derived from the entry date (941): the database's own invariants, on real
 * PostgreSQL. Each test names the trigger or constraint it pins.
 * All data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const co = crypto.randomUUID(), user = crypto.randomUUID();
const acctA = crypto.randomUUID(), acctB = crypto.randomUUID();

const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { code?: string; message: string }; } };

async function addPeriod(start: string, end: string, label: number, num: number, status = 'open') {
  const r = await q(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, fiscal_year_id`,
    [co, `P ${start}`, num, label, start, end, status]);
  return r.rows[0] as { id: string; fiscal_year_id: string };
}
const years = async () => (await q(
  `SELECT fiscal_year, start_date::text s, end_date::text e, status FROM fiscal_years WHERE company_id = $1 ORDER BY start_date`,
  [co])).rows;
async function journal(date: string, periodId: string | null = null) {
  const r = await q(
    `INSERT INTO gl_journal_entries (company_id, entry_date, fiscal_period_id, created_by, description, status)
     VALUES ($1, $2, $3, $4, 'fy-inv', 'draft') RETURNING id, fiscal_period_id`, [co, date, periodId, user]);
  return r.rows[0] as { id: string; fiscal_period_id: string | null };
}

beforeAll(async () => {
  await q(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYINV co', 3)`, [co]);
  await q(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  await q(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'FYI-1', 'FYI bank', 'asset', 'debit', 3, true), ($2, $3, 'FYI-2', 'FYI sales', 'revenue', 'credit', 3, true)`,
    [acctA, acctB, co]);
});

afterAll(async () => {
  try {
    await q('DELETE FROM gl_account_balances WHERE gl_account_id IN ($1, $2)', [acctA, acctB]);
    await q('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)', [co]);
    await q('DELETE FROM gl_journal_entries WHERE company_id = $1', [co]);
    await q('DELETE FROM gl_account_balances WHERE gl_account_id IN ($1, $2)', [acctA, acctB]);
    await q('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
    await q('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await q('DELETE FROM companies WHERE id = $1', [co]);
    await q('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
});

describe('linking a period to its year (fiscal_periods_link_year)', () => {
  it('creates the DECLARED (March) year for a monthly period, whatever its January-December label says', async () => {
    const p = await addPeriod('2025-01-01', '2025-01-31', 2025, 1);
    const y = (await q('SELECT fiscal_year, start_date::text s, end_date::text e FROM fiscal_years WHERE id = $1', [p.fiscal_year_id])).rows[0];
    expect(y).toEqual({ fiscal_year: 2025, s: '2024-03-01', e: '2025-02-28' });
  });

  it('links the next month to the same year and March to the next one, chained twelve months on', async () => {
    const feb = await addPeriod('2025-02-01', '2025-02-28', 2025, 2);
    const mar = await addPeriod('2025-03-01', '2025-03-31', 2025, 3);
    const jan = (await q(`SELECT fiscal_year_id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-01-01'`, [co])).rows[0];
    expect(feb.fiscal_year_id).toBe(jan.fiscal_year_id);
    expect(mar.fiscal_year_id).not.toBe(jan.fiscal_year_id);
    expect((await years()).map((r) => [r.fiscal_year, r.s, r.e])).toEqual([
      [2025, '2024-03-01', '2025-02-28'], [2026, '2025-03-01', '2026-02-28']]);
  });
});

describe('year constraints', () => {
  it('refuses a year longer than 15 months (fiscal_years_at_most_15_months)', async () => {
    const e = await err(q(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2040, '2039-01-01', '2040-04-30')`, [co]));
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/at_most_15_months/);
  });
  it('accepts exactly 15 months', async () => {
    await q(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2041, '2040-01-01', '2041-03-31')`, [co]); // 15 months
    await q(`DELETE FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2041`, [co]);
  });
  it('refuses overlapping years (fiscal_years_no_overlap)', async () => {
    const e = await err(q(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2042, '2026-01-01', '2026-06-30')`, [co]));
    expect(e?.code).toBe('23P01');
  });
  it('refuses a year that no longer holds its periods (deferred trg_fiscal_years_holds_periods)', async () => {
    const e = await err(q(`UPDATE fiscal_years SET end_date = '2025-03-15' WHERE company_id = $1 AND fiscal_year = 2026`, [co]));
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/no longer holds its period/);
  });
  it('refuses a period moved outside its year (deferred trg_fiscal_periods_inside_year)', async () => {
    const other = (await q(`SELECT id FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2025`, [co])).rows[0].id;
    const e = await err(q(`UPDATE fiscal_periods SET fiscal_year_id = $2 WHERE company_id = $1 AND start_date = '2025-03-01'`, [co, other]));
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/outside its fiscal year/);
  });
});

describe('status follows the periods, and closed is immutable', () => {
  it('a year is closed only when every day of it is covered by closed periods', async () => {
    await q(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date < '2025-03-01'`, [co]);
    // Jan + Feb closed, but Mar-Dec 2024 have no periods: the year is NOT closed.
    expect((await years())[0].status).toBe('open');
    for (let m = 3; m <= 12; m++) {
      const s = `2024-${String(m).padStart(2, '0')}-01`;
      const end = (await q(`SELECT ($1::date + INTERVAL '1 month' - INTERVAL '1 day')::date::text AS e`, [s])).rows[0].e;
      await addPeriod(s, end, 2024, m, 'closed');
    }
    expect((await years())[0].status).toBe('closed');
  });

  it('a period with status closing makes its year closing', async () => {
    await q(`UPDATE fiscal_periods SET status = 'closing' WHERE company_id = $1 AND start_date = '2025-03-01'`, [co]);
    expect((await years())[1].status).toBe('closing');
    await q(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2025-03-01'`, [co]);
    expect((await years())[1].status).toBe('open');
  });

  it('refuses re-dating or relabelling a closed period (trg_fiscal_periods_b_guard_closed)', async () => {
    for (const set of [`end_date = '2025-01-30'`, `fiscal_year = 2099`, `period_number = 99`]) {
      const e = await err(q(`UPDATE fiscal_periods SET ${set} WHERE company_id = $1 AND start_date = '2025-01-01'`, [co]));
      expect(e?.code, set).toBe('55000');
    }
  });

  it('refuses re-dating a closed year and deleting it (trg_fiscal_years_guard_closed / _delete)', async () => {
    expect((await err(q(`UPDATE fiscal_years SET fiscal_year = 2099 WHERE company_id = $1 AND fiscal_year = 2025`, [co])))?.code).toBe('55000');
    expect((await err(q(`DELETE FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2025`, [co])))?.code).toBe('55000');
  });

  it('refuses a written year status: it is always derived (trg_fiscal_years_guard_closed / _insert_open)', async () => {
    await q(`UPDATE fiscal_years SET status = 'locked' WHERE company_id = $1 AND fiscal_year = 2026`, [co]);
    expect((await years())[1].status).toBe('open');
    await q(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, status) VALUES ($1, 2050, '2049-03-01', '2050-02-28', 'closed')`, [co]);
    expect((await q(`SELECT status FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2050`, [co])).rows[0].status).toBe('open');
    await q(`DELETE FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2050`, [co]);
  });

  it('reopening a period reopens its year, and a status change alone is allowed', async () => {
    await q(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2025-01-01'`, [co]);
    expect((await years())[0].status).toBe('open');
  });
});

describe("a journal's period is derived from its entry_date (941)", () => {
  it('fills a NULL period from the date', async () => {
    const j = await journal('2025-03-15');
    const mar = (await q(`SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-03-01'`, [co])).rows[0].id;
    expect(j.fiscal_period_id).toBe(mar);
  });

  it('refuses an explicit period that does not hold the date', async () => {
    const feb = (await q(`SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-02-01'`, [co])).rows[0].id;
    const e = await err(journal('2025-03-15', feb));
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/is not the period that holds that date/);
  });

  it('re-derives the period when the date moves, and refuses a mismatched explicit move', async () => {
    const j = await journal('2025-03-20');
    const feb = (await q(`SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-02-01'`, [co])).rows[0].id;
    await q(`UPDATE gl_journal_entries SET entry_date = '2025-02-10' WHERE id = $1`, [j.id]);
    expect((await q('SELECT fiscal_period_id FROM gl_journal_entries WHERE id = $1', [j.id])).rows[0].fiscal_period_id).toBe(feb);
    const mar = (await q(`SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-03-01'`, [co])).rows[0].id;
    expect((await err(q('UPDATE gl_journal_entries SET fiscal_period_id = $2 WHERE id = $1', [j.id, mar])))?.code).toBe('23514');
  });

  it('leaves an unrelated update alone even when the stored period is already wrong', async () => {
    const j = await journal('2025-03-25');
    const feb = (await q(`SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-02-01'`, [co])).rows[0].id;
    await q('ALTER TABLE gl_journal_entries DISABLE TRIGGER trg_gl_je_fiscal_period_from_date');
    try { await q('UPDATE gl_journal_entries SET fiscal_period_id = $2 WHERE id = $1', [j.id, feb]); }
    finally { await q('ALTER TABLE gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_fiscal_period_from_date'); }
    await q(`UPDATE gl_journal_entries SET description = 'touched' WHERE id = $1`, [j.id]);
    expect((await q('SELECT fiscal_period_id FROM gl_journal_entries WHERE id = $1', [j.id])).rows[0].fiscal_period_id).toBe(feb);
  });

  it('moves the balance cache with a re-pointed posted journal (trg_gl_je_status_balance)', async () => {
    const j = await journal('2025-03-05');
    await q(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
             VALUES ($1, $2, $3, 100, 0, 'a'), ($1, $2, $4, 0, 100, 'b')`, [j.id, co, acctA, acctB]);
    await q(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [j.id, user]);
    const bal = async (start: string) => (await q(
      `SELECT COALESCE(SUM(b.debit_total), 0)::numeric AS d FROM gl_account_balances b JOIN fiscal_periods fp ON fp.id = b.fiscal_period_id
        WHERE b.gl_account_id = $1 AND fp.company_id = $2 AND fp.start_date = $3`, [acctA, co, start])).rows[0].d;
    expect(Number(await bal('2025-03-01'))).toBe(100);
    // A posted entry may not move to a date no period covers (it would leave every period report).
    const e = await err(q(`UPDATE gl_journal_entries SET entry_date = '2025-04-05' WHERE id = $1`, [j.id]));
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/no fiscal period covers the new entry_date/);
    // Into a covered month: the period re-derives and the cache moves with it.
    await addPeriod('2025-04-01', '2025-04-30', 2025, 4);
    await q(`UPDATE gl_journal_entries SET entry_date = '2025-04-05' WHERE id = $1`, [j.id]);
    expect(Number(await bal('2025-03-01'))).toBe(0);
    expect(Number(await bal('2025-04-01'))).toBe(100);
  });
});

describe('tenant and deletion guards', () => {
  it('refuses a period linked to ANOTHER company\'s year (composite FK), whatever RLS shows', async () => {
    const other = crypto.randomUUID();
    await q(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYINV other', 3)`, [other]);
    try {
      const theirs = (await q(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2031, '2030-03-01', '2031-02-28') RETURNING id`, [other])).rows[0].id;
      const e = await err(q(`INSERT INTO fiscal_periods (company_id, fiscal_year_id, period_name, period_number, fiscal_year, start_date, end_date)
                             VALUES ($1, $2, 'X', 1, 2031, '2030-03-01', '2030-03-31')`, [co, theirs]));
      expect(e?.code).toBe('23503');
    } finally {
      await q('DELETE FROM fiscal_years WHERE company_id = $1', [other]);
      await q('DELETE FROM companies WHERE id = $1', [other]);
    }
  });

  it('the app role cannot delete a closed period of a company with journals (it would reopen the year)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [co, user]);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [co]);
      const e = await err(client.query(`DELETE FROM fiscal_periods WHERE company_id = $1 AND start_date = '2024-03-01'`, [co]));
      expect(e?.code).toBe('55000');
      expect(e?.message).toMatch(/cannot be deleted/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
