/**
 * K-113 — a re-run of a year-end close must not read as a year that never traded.
 *
 * The validator's RED file proved two halves on `origin/master`: the second dry
 * run returned `{ dryRun: true, netIncome: 0, preview }` with no signal at all,
 * and the second live call died on 23505
 * `uq_gl_je_company_entry_number`. Both are here, asserted against the shape
 * that was actually delivered.
 *
 * That shape differs from the one the validator proposed, deliberately. It
 * suggested a new `error: 'already_closed'` refusal; the close instead reports
 * SUCCESS carrying `alreadyClosed: true` and the existing journal. The live
 * trigger the validation itself names is an MCP retry after a timeout, and a
 * retry that lands on "the work is already done, here it is" is the answer that
 * makes the operation idempotent. The distinction the finding is actually about
 * — a closed year must not be indistinguishable from a dormant one — is carried
 * by the flag and the journal, in the dry run as well as the live call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();

interface Tenant {
  company: string; revenue: string; expense: string; bank: string; retained: string; period: string;
}

function tenant(): Tenant {
  return {
    company: crypto.randomUUID(), revenue: crypto.randomUUID(), expense: crypto.randomUUID(),
    bank: crypto.randomUUID(), retained: crypto.randomUUID(), period: crypto.randomUUID(),
  };
}

/** Traded, then closed. */
const traded = tenant();
/** Never traded at all — the state the closed year used to be mistaken for. */
const dormant = tenant();

async function seed(t: Tenant, name: string) {
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [t.company, name]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'4000','Sales','revenue',NULL,'credit',true,false),
           ($3,$2,'5000','Rent','expense',NULL,'debit',true,false),
           ($4,$2,'1000','Bank','asset',NULL,'debit',true,false),
           ($5,$2,'3200','Retained Earnings','equity','retained_earnings','credit',true,true)`,
    [t.revenue, t.company, t.expense, t.bank, t.retained]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$2,'FY2026',1,2026,'2026-01-01','2026-12-31','closed')`,
    [t.period, t.company]);
  clearSystemAccountCache(t.company);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `k113-${user}@test.local`]);
  await seed(traded, 'K113 traded');
  await seed(dormant, 'K113 dormant');
  const je = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,'K113-SALE','2026-06-30',$3,'seed','manual','posted',$4,$4,now())`,
    [je, traded.company, traded.period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,600,0,'seed',$4),($1,$3,0,600,'seed',$4)`,
    [je, traded.bank, traded.revenue, traded.company]);
});

afterAll(async () => {
  try {
    for (const t of [traded, dormant]) {
      clearSystemAccountCache(t.company);
      await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [t.company]);
      await pool.query(
        'DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)',
        [t.company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [t.company]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('K-113: the dry run of an already-closed year says so', () => {
  it('reports alreadyClosed with the existing journal, where a dormant year reports neither', async () => {
    const first = await closeFiscalYear(traded.company, '2026', user) as
      { netIncome: number; closingEntry: { id: string; entry_number: string } };
    expect(first.netIncome).toBe(600);

    // HALF ONE of the validator's RED file: the preview a person reads before
    // authorising the second attempt. Its aggregates are flat — the first close
    // is what flattened them — so `netIncome: 0` with an empty journal is all
    // the caller used to get, byte-for-byte what a company that never traded
    // returns.
    const dry = await closeFiscalYear(traded.company, '2026', user, { dryRun: true }) as {
      dryRun: true; netIncome: number; alreadyClosed: boolean;
      existingEntry: { id: string; entry_number: string } | null;
      preview: { lines: unknown[] };
    };
    expect(dry.dryRun).toBe(true);
    expect(dry.alreadyClosed).toBe(true);
    expect(dry.existingEntry?.entry_number).toBe('YE-2026');
    expect(dry.existingEntry?.id).toBe(first.closingEntry.id);

    // The dormant year is the control. Same `netIncome`, same empty preview —
    // and that is exactly why the flag has to be the thing that separates them.
    const dormantDry = await closeFiscalYear(dormant.company, '2026', user, { dryRun: true }) as {
      netIncome: number; alreadyClosed: boolean; existingEntry: unknown; preview: { lines: unknown[] };
    };
    expect(dormantDry.netIncome).toBe(dry.netIncome);
    expect(dormantDry.preview.lines).toEqual(dry.preview.lines);
    expect(dormantDry.alreadyClosed).toBe(false);
    expect(dormantDry.existingEntry).toBeNull();
  });

  it('answers the live re-run in its own vocabulary, not with a Postgres error code', async () => {
    // HALF TWO: on master this threw 23505 on uq_gl_je_company_entry_number and
    // surfaced as a 500 "Failed to process year-end".
    const again = await closeFiscalYear(traded.company, '2026', user) as {
      alreadyClosed: boolean; closingEntry: { entry_number: string } | null;
      periodsLocked: number; message: string;
    };
    expect(again.alreadyClosed).toBe(true);
    expect(again.closingEntry?.entry_number).toBe('YE-2026');
    expect(again.message).toMatch(/already closed/i);

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",
      [traded.company]);
    expect(count.rows[0].n).toBe(1);
  });

  it('answers a re-run whose year gained P&L movement AFTER the close, without a 23505', async () => {
    // The one re-run shape the poster's old lookup could never see: movement
    // landed in the closed year, so the preview is NOT empty, and the close ran
    // straight at the INSERT and collided on the fixed entry number.
    const je = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
       VALUES($1,$2,'K113-LATE','2026-07-31',$3,'late','manual','posted',$4,$4,now())`,
      [je, traded.company, traded.period, user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,150,0,'late',$4),($1,$3,0,150,'late',$4)`,
      [je, traded.bank, traded.revenue, traded.company]);

    const again = await closeFiscalYear(traded.company, '2026', user) as
      { alreadyClosed: boolean; netIncome: number; unclosedNetIncome: number; message: string };
    expect(again.alreadyClosed).toBe(true);
    expect(again.netIncome).toBe(150);

    // And it SAYS so. That R150 is in no closing journal and in no equity
    // account, and no re-run can ever sweep it up, because YE-2026 is taken.
    // "Already closed. Nothing was posted." on its own is a true sentence that
    // leaves an operator believing the year is complete when it is not — the
    // 23505 this replaced was at least loud.
    expect(again.unclosedNetIncome).toBe(150);
    expect(again.message).toMatch(/R150\.00 of profit or loss has been posted into this year SINCE it was closed/);
    expect(again.message).toMatch(/NOT in retained earnings/);

    // The residual is exactly the gap between the year's posted P&L and what
    // the closing journal moved into equity — asserted against the ledger, not
    // against the number the service just reported.
    const moved = await pool.query(
      `SELECT COALESCE(SUM(jl.credit - jl.debit),0)::numeric AS n
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       WHERE jl.company_id=$1 AND je.source='year_end' AND jl.gl_account_id=$2`,
      [traded.company, traded.retained]);
    const posted = await pool.query(
      `SELECT COALESCE(SUM(jl.credit - jl.debit),0)::numeric AS n
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
       WHERE jl.company_id=$1 AND je.status='posted' AND je.source <> 'year_end'
         AND ga.account_type IN ('revenue','expense')
         AND je.entry_date BETWEEN '2026-01-01' AND '2026-12-31'`,
      [traded.company]);
    expect(Number(posted.rows[0].n) - Number(moved.rows[0].n)).toBe(again.unclosedNetIncome);

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",
      [traded.company]);
    expect(count.rows[0].n).toBe(1);
  });
});
