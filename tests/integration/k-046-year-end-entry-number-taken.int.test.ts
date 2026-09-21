/**
 * The closing entry number is unique per company with NO predicate on source
 * and none on status, so anything holding `YE-<year>` blocks the close.
 *
 * Round-3 findings, both proved against the real index rather than a mock of
 * it. M-2: a journal of another source carrying the number was invisible to the
 * guard, so the close fell through to the INSERT and answered a raw 23505 →
 * HTTP 500 "Failed to process year-end" — opaque, and indistinguishable from a
 * transient failure worth retrying. L-1: two simultaneous closes both read the
 * guard's `null` and both reach the INSERT; the index keeps the ledger to one
 * journal, and the loser must report that year as closed, not 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { alreadyClosedResult } from '../../src/modules/accounting/services/gl/yearEndJournalPoster';
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

const squatted = tenant();  // a manual journal already numbered YE-2026
const raced = tenant();     // two closes fired at once
const residual = tenant();  // closed, then P&L landed in the closed year

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

/** One posted journal in the year, under the given entry number and source. */
async function post(
  t: Tenant, left: string, right: string, amount: number, ref: string, source = 'manual',
) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,'2026-06-30',$4,'seed',$5,'posted',$6,$6,now())`,
    [id, t.company, ref, t.period, source, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`,
    [id, left, right, amount, t.company]);
  return id;
}

let squatterId = '';

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `k046ent-${user}@test.local`]);
  await seed(squatted, 'K046 squatted');
  await seed(raced, 'K046 raced');
  await seed(residual, 'K046 residual');
  // A user numbered an ordinary journal YE-2026. It is a real posted journal
  // with real lines — it is simply not a year-end close.
  squatterId = await post(squatted, squatted.bank, squatted.revenue, 900, 'YE-2026');
  await post(raced, raced.bank, raced.revenue, 700, 'R-SALE');
  // Closed on R800, and then R150 of sales landed IN the closed year. Nothing
  // in the DB refuses a posting into a locked period, and once one lands the
  // close can never sweep it up: YE-2026 is taken by the close itself.
  await post(residual, residual.bank, residual.revenue, 800, 'RES-SALE');
  await closeFiscalYear(residual.company, '2026', user);
  await post(residual, residual.bank, residual.revenue, 150, 'RES-LATE');
});

afterAll(async () => {
  try {
    for (const t of [squatted, raced, residual]) {
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
  } finally { await pool.end(); }
});

describe('a journal of another source holding YE-<year>', () => {
  it('is refused by name, and the year is left exactly as it was', async () => {
    const result = await closeFiscalYear(squatted.company, '2026', user) as
      { error: string; entryNumber: string; entryId: string; source: string; status: string };

    expect(result.error).toBe('closing_entry_number_taken');
    expect(result.entryNumber).toBe('YE-2026');
    expect(result.entryId).toBe(squatterId);
    expect(result.source).toBe('manual');
    expect(result.status).toBe('posted');

    // Nothing written, nothing locked: the refusal lands before the transaction.
    const closes = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",
      [squatted.company]);
    expect(closes.rows[0].n).toBe(0);
    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2',
      [squatted.company, '2026']);
    expect(periods.rows.map((r) => r.status)).toEqual(['closed']);
  });

  it('refuses the DRY RUN identically, rather than previewing a close the index forbids', async () => {
    const dry = await closeFiscalYear(squatted.company, '2026', user, { dryRun: true }) as
      { error: string; entryId: string };
    expect(dry.error).toBe('closing_entry_number_taken');
    expect(dry.entryId).toBe(squatterId);
  });

  it('renumbering the squatter unblocks the year', async () => {
    // Proves the refusal names an ACTIONABLE fix — the message tells a person to
    // renumber that journal, and doing so is sufficient.
    await pool.query('UPDATE gl_journal_entries SET entry_number=$1 WHERE id=$2 AND company_id=$3',
      ['JNL-0001', squatterId, squatted.company]);

    const result = await closeFiscalYear(squatted.company, '2026', user) as
      { netIncome: number; closingEntry: { id: string }; unclosedNetIncome: number };
    expect(result.netIncome).toBe(900);
    expect(result.unclosedNetIncome).toBe(0);

    const lines = await pool.query(
      'SELECT SUM(debit)::numeric AS d, SUM(credit)::numeric AS c FROM gl_journal_lines WHERE journal_entry_id=$1 AND company_id=$2',
      [result.closingEntry.id, squatted.company]);
    expect(Number(lines.rows[0].d)).toBe(Number(lines.rows[0].c));
    // The equity leg equals the year's result, so the journal agrees with the
    // trial balance it closes.
    const equity = await pool.query(
      'SELECT (credit - debit)::numeric AS n FROM gl_journal_lines WHERE journal_entry_id=$1 AND gl_account_id=$2 AND company_id=$3',
      [result.closingEntry.id, squatted.retained, squatted.company]);
    expect(Number(equity.rows[0].n)).toBe(900);
  });
});

describe('two closes fired at once', () => {
  it('writes ONE journal and tells the loser the year is closed', async () => {
    const [one, two] = await Promise.all([
      closeFiscalYear(raced.company, '2026', user),
      closeFiscalYear(raced.company, '2026', user),
    ]) as Array<{
      alreadyClosed: boolean; closingEntry: { id: string } | null;
      netIncome: number; unclosedNetIncome: number; message: string;
    }>;

    // Exactly one journal exists — the unique index, not the application, is
    // what guarantees that, which is why this is asserted against the table.
    const closes = await pool.query(
      "SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [raced.company]);
    expect(closes.rows).toHaveLength(1);

    // Neither call throws, and both point at the one journal that exists.
    expect(one.closingEntry?.id).toBe(closes.rows[0].id);
    expect(two.closingEntry?.id).toBe(closes.rows[0].id);
    // Exactly one of them did the writing.
    expect([one.alreadyClosed, two.alreadyClosed].filter(Boolean)).toHaveLength(1);

    // And the LOSER raises no false alarm. BOTH numbers are re-read after the
    // closing journal is known to exist, so both are pinned and neither is a
    // scheduling artefact: reporting the R700 the winner has just moved into
    // equity — as `net_income` or as the residual — would send an operator
    // hunting for a hole in a year that is correctly closed.
    const loser = one.alreadyClosed ? one : two;
    expect(loser.netIncome).toBe(0);
    expect(loser.unclosedNetIncome).toBe(0);
    expect(loser.message).not.toMatch(/WARNING/);

    // The equity leg still equals the year's result exactly once.
    const equity = await pool.query(
      `SELECT COALESCE(SUM(jl.credit - jl.debit),0)::numeric AS n
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
       WHERE jl.company_id=$1 AND je.source='year_end' AND jl.gl_account_id=$2`,
      [raced.company, raced.retained]);
    expect(Number(equity.rows[0].n)).toBe(700);
  });
});

describe('P&L that landed in a year AFTER its close', () => {
  const range = { start_date: '2026-01-01', end_date: '2026-12-31' };

  it('is re-read from the LEDGER on every call, never frozen at the first one', async () => {
    // The deterministic cover for the re-read. The race test cannot provide it:
    // whichever value the loser's pre-lookup read caught is a scheduling
    // artefact. Here the ledger MOVES between two calls on the same entry, so
    // an implementation that computed the residual once — or carried a number
    // in from the caller — reports the first figure twice and fails.
    const entry = (await pool.query(
      "SELECT * FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",
      [residual.company])).rows[0];

    const first = await alreadyClosedResult(residual.company, '2026', entry, range);
    expect(first.unclosedNetIncome).toBe(150);
    // `netIncome` is the SAME re-read, so it agrees rather than reporting a
    // stale pre-lookup figure beside a correct residual.
    expect(first.netIncome).toBe(150);
    expect(first.alreadyClosed).toBe(true);
    expect(first.message).toMatch(/WARNING: R150\.00/);

    await post(residual, residual.bank, residual.revenue, 40, 'RES-LATER');
    try {
      const second = await alreadyClosedResult(residual.company, '2026', entry, range);
      expect(second.unclosedNetIncome).toBe(190);
      expect(second.netIncome).toBe(190);
      expect(second.message).toMatch(/WARNING: R190\.00/);
    } finally {
      // The later tests in this block pin R150, so put the ledger back.
      await pool.query(
        `DELETE FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id IN
           (SELECT id FROM gl_journal_entries WHERE company_id=$1 AND entry_number='RES-LATER')`,
        [residual.company]);
      await pool.query(
        "DELETE FROM gl_journal_entries WHERE company_id=$1 AND entry_number='RES-LATER'",
        [residual.company]);
    }
  });

  it('is reported by the DRY RUN as a residual, never as a journal it would post', async () => {
    // A closed year that gained P&L has a NON-EMPTY preview — that movement is
    // exactly what it contains — and the live call refuses to write it. The dry
    // run is the authorising read, so it must not describe a posting the live
    // path will never make.
    const dry = await closeFiscalYear(residual.company, '2026', user, { dryRun: true }) as
      { alreadyClosed: boolean; unclosedNetIncome: number; netIncome: number;
        preview: null; residualPreview: { lines: unknown[]; totalDebit: number } };

    expect(dry.alreadyClosed).toBe(true);
    expect(dry.unclosedNetIncome).toBe(150);
    // `preview` — the field a consumer reads as "the journal this would post" —
    // is NULL by construction on this branch, not merely documented as unsafe.
    expect(dry.preview).toBeNull();
    // The residual is non-empty, balanced, and unpostable, under its own name.
    expect(dry.residualPreview.lines.length).toBeGreaterThan(0);
    expect(dry.residualPreview.totalDebit).toBe(150);

    // And the live call agrees with it — same number, and it writes nothing.
    const live = await closeFiscalYear(residual.company, '2026', user) as
      { alreadyClosed: boolean; unclosedNetIncome: number; message: string };
    expect(live.alreadyClosed).toBe(true);
    expect(live.unclosedNetIncome).toBe(150);
    expect(live.message).toMatch(/WARNING: R150\.00/);

    const closes = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",
      [residual.company]);
    expect(closes.rows[0].n).toBe(1);
  });
});
