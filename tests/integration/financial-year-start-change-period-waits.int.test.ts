/**
 * A start-month change in Settings (assertFinancialYearStartChange) against
 * the period lockers, review of PR #1551 at 3e8e55adca:
 *
 * 1. HIGH. The change held companies FOR UPDATE and then waited for every
 *    period row. A live year-end close holds its periods FOR NO KEY UPDATE and
 *    then INSERTs its closing journal, whose company FK takes FOR KEY SHARE on
 *    companies, which FOR UPDATE blocks: 40P01. The change now refuses on the
 *    counts (a posted journal, a closed period) BEFORE it takes any period lock;
 *    a company with a year to close always has both. Real data: the year is
 *    generated, the journal posted, the periods closed, no flag set by hand.
 * 2. MEDIUM. That period wait had no bound while companies was held FOR UPDATE
 *    (every FK insert for the company stalls behind it). It is now bounded
 *    (withRowLockBudget, 5 s): a retryable RowLockTimeoutError, 503.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { updateCompany } from '@/modules/accounting/services/core/companyService';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { judgePeriodClose } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndCloseService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const user = crypto.randomUUID();
const made: string[] = [];

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    for (const id of made) {
      clearSystemAccountCache(id);
      await pool.query('DELETE FROM audit_log WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id = $1)', [id]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
      await pool.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1`, [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60000);

async function request(companyId: string) {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  return {
    client,
    run: <T>(fn: () => Promise<T>) => als.run({ client, companyId, userId: user, claims: {} } as never, fn),
    end: async (how: 'COMMIT' | 'ROLLBACK') => { try { await client.query(how); } finally { client.release(); } },
  };
}
type Request = Awaited<ReturnType<typeof request>>;
async function settle(r: Request, fn: () => Promise<unknown>): Promise<unknown> {
  const out = await r.run(fn).then(() => 'ok', (e: unknown) => e);
  await r.end(out === 'ok' ? 'COMMIT' : 'ROLLBACK');
  return out;
}
const once = async <T>(c: string, fn: () => Promise<T>) => {
  const r = await request(c);
  try { const out = await r.run(fn); await r.end('COMMIT'); return out; } catch (e) { await r.end('ROLLBACK'); throw e; }
};

/** The first statement on `client` matching `re` waits for `before()` first. */
function pauseBefore(client: PoolClient, re: RegExp, before: () => Promise<void>): () => void {
  const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
  let fired = false;
  (client as unknown as { query: unknown }).query = (...q: unknown[]) => {
    if (!fired && typeof q[0] === 'string' && re.test(q[0])) { fired = true; return before().then(() => query(...q)); }
    return query(...q);
  };
  return () => { (client as unknown as { query: unknown }).query = query; };
}

/** Until `settled` resolves or some backend waits on a lock. */
async function waitsOrSettles(settled: Promise<unknown>): Promise<void> {
  let done = false;
  void settled.then(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!done) throw new Error('the start-month change neither waited nor finished');
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const describeOutcome = (e: unknown) => (typeof e === 'string' ? e : `${codeOf(e) ?? ''} ${(e as Error).name}: ${String(e)}`);
const deadlocked = (e: unknown) => codeOf(e) === '40P01' || /deadlock detected/.test(String(e));

async function newCompany(name: string): Promise<string> {
  const c = crypto.randomUUID();
  made.push(c);
  await pool.query('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, 1)', [c, name]);
  return c;
}

describe('start-month change in Settings vs a live year-end close', () => {
  it('the change refuses (409) without waiting on the periods; the close writes its journal; nobody gets 40P01', async () => {
    const c = await newCompany('START MONTH vs YEAR END co');
    await once(c, () => generateFiscalYearForDate(c, '2025-06-01'));      // FY2025, Jan-Dec 2025, declared January
    const [revenue, bank, retained] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
       VALUES ($1, $4, '4000', 'Sales', 'revenue', NULL, 'credit', true, false),
              ($2, $4, '1000', 'Bank', 'asset', NULL, 'debit', true, false),
              ($3, $4, '3200', 'Retained Earnings', 'equity', 'retained_earnings', 'credit', true, true)`,
      [revenue, bank, retained, c]);
    clearSystemAccountCache(c);
    const { rows: [jun] } = await pool.query(
      `SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2025-06-01'`, [c]);
    const sale = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
       VALUES ($1, $2, 'S-1', '2025-06-15', $3, 'sale', 'manual', 'posted', $4, $4, now())`, [sale, c, jun.id, user]);
    await pool.query(
      `INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
       VALUES ($1, $2, 500, 0, 'sale', $4), ($1, $3, 0, 500, 'sale', $4)`, [sale, bank, revenue, c]);
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1`, [c]);

    const close = await request(c);
    let changed: Promise<unknown> | null = null;
    // The close holds the year's periods; just before its closing journal INSERT the change starts.
    const restore = pauseBefore(close.client, /^\s*INSERT INTO gl_journal_entries\b/, async () => {
      const save = await request(c);
      changed = settle(save, () => updateCompany(c, { financialYearStart: 3, loadedFinancialYearStart: 1 }));
      await waitsOrSettles(changed);
    });
    const closed = await settle(close, async () => {
      try {
        const r = await closeFiscalYear(c, '2025', user) as { error?: string };
        if (r.error) throw new Error(`year-end close refused: ${JSON.stringify(r)}`);
      } finally { restore(); }
    });
    const change = await (changed ?? Promise.resolve('the change never started'));

    expect(deadlocked(closed), describeOutcome(closed)).toBe(false);
    expect(deadlocked(change), describeOutcome(change)).toBe(false);
    expect(describeOutcome(closed)).toBe('ok');
    expect((change as Error).name, describeOutcome(change)).toBe('FinancialYearStartLockedError');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND source = 'year_end'`, [c]);
    expect(rows[0].n).toBe(1);
    const { rows: [co] } = await pool.query('SELECT financial_year_start AS m FROM companies WHERE id = $1', [c]);
    expect(co.m).toBe(1);
  }, 60000);
});

describe('start-month change in Settings: the wait for the periods is bounded', () => {
  it('a period held past the budget: RowLockTimeoutError (503, retry), not an unbounded wait', async () => {
    const c = await newCompany('START MONTH bound co');
    await once(c, () => generateFiscalYearForDate(c, '2026-06-01'));      // open periods, nothing posted: the change is allowed
    const { rows: [jan] } = await pool.query(
      `SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = '2026-01-01'`, [c]);

    const holder = await request(c);
    try {
      await holder.run(() => judgePeriodClose(c, jan.id));                 // a close judging January holds its row
      const save = await request(c);
      const changed = settle(save, () => updateCompany(c, { financialYearStart: 3, loadedFinancialYearStart: 1 }));
      const unbounded = new Promise((r) => setTimeout(() => r('still waiting after 20 s'), 20000));
      const out = await Promise.race([changed, unbounded]);
      expect(describeOutcome(out)).toMatch(/RowLockTimeoutError/);
      const { rows: [co] } = await pool.query('SELECT financial_year_start AS m FROM companies WHERE id = $1', [c]);
      expect(co.m).toBe(1);
    } finally {
      await holder.end('ROLLBACK');
    }
  }, 60000);
});
