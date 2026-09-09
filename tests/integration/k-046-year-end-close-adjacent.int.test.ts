/**
 * K-046 adjacent cases for the year-end close, on the real schema.
 *
 * The RED test proves the contra revenue line and the rejected `source`. These
 * are the cases around it: the close actually WRITES for the first time, so
 * what it writes has to tie out — a balanced journal, retained earnings equal
 * to the year's result, every period locked — and it has to leave a second
 * tenant alone. The mirror case (a contra EXPENSE account) exercises the other
 * half of the sign fix, and the second-close case records what the already-
 * closed state does now (K-113, unfixed here).
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

const a = tenant();
const b = tenant();
const c = tenant();  // break-even year: revenue exactly equals expenses
const d = tenant();  // dormant year: nothing posted at all
const e = tenant();  // a DEACTIVATED revenue account still carrying a balance
const f = tenant();  // a year whose closing journal was later reversed

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
     VALUES($1,$2,'FY2025',1,2025,'2025-01-01','2025-12-31','closed')`,
    [t.period, t.company]);
  clearSystemAccountCache(t.company);
}

/** One posted journal in the year: `debit` on `left`, `credit` on `right`. */
async function post(t: Tenant, left: string, right: string, amount: number, ref: string, date = '2025-06-30') {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'seed','manual','posted',$6,$6,now())`,
    [id, t.company, ref, date, t.period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`,
    [id, left, right, amount, t.company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `k046adj-${user}@test.local`]);
  await seed(a, 'K046 tenant A');
  await seed(b, 'K046 tenant B');
  await seed(c, 'K046 tenant C');
  await seed(d, 'K046 tenant D');
  await seed(e, 'K046 tenant E');
  await seed(f, 'K046 tenant F');
  // Tenant A: revenue 4000 carries a net DEBIT of 500 (a refund bigger than the
  // year's billing), expense 5000 carries a normal debit of 200.
  await post(a, a.revenue, a.bank, 500, 'A-REFUND');
  await post(a, a.expense, a.bank, 200, 'A-RENT');
  // Tenant B: a contra EXPENSE — 5000 carries a net CREDIT of 300 (a supplier
  // rebate) — plus normal revenue of 1000.
  await post(b, b.bank, b.expense, 300, 'B-REBATE');
  await post(b, b.bank, b.revenue, 1000, 'B-SALE');
  // Tenant C: revenue 1000 and expenses 1000 — a break-even year, netIncome 0.
  await post(c, c.bank, c.revenue, 1000, 'C-SALE');
  await post(c, c.expense, c.bank, 1000, 'C-COST');
  // Tenant D: nothing posted at all.
  // Tenant E: revenue of 1000, then the revenue account is WITHDRAWN.
  await post(e, e.bank, e.revenue, 1000, 'E-SALE');
  await pool.query('UPDATE gl_accounts SET is_active=false WHERE id=$1 AND company_id=$2',
    [e.revenue, e.company]);
  clearSystemAccountCache(e.company);
  // Tenant F: revenue of 400; its close, and the reversal of it, happen in the test.
  await post(f, f.bank, f.revenue, 400, 'F-SALE');
});

afterAll(async () => {
  try {
    for (const t of [a, b, c, d, e, f]) {
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

describe('year-end close with a contra revenue account (tenant A)', () => {
  it('posts a balanced closing journal that ties to the year result and locks the year', async () => {
    // Net income = revenue (-500) - expenses (200) = -700, a loss.
    const result = await closeFiscalYear(a.company, '2025', user) as { netIncome: number; closingEntry: { id: string } };
    expect(result.netIncome).toBe(-700);

    const entryId = result.closingEntry.id;
    const header = await pool.query(
      'SELECT source, status, entry_number, fiscal_period_id FROM gl_journal_entries WHERE id=$1 AND company_id=$2',
      [entryId, a.company]);
    expect(header.rows[0]).toMatchObject({ source: 'year_end', status: 'posted', entry_number: 'YE-2025' });
    expect(header.rows[0].fiscal_period_id).toBe(a.period);

    const lines = await pool.query(
      `SELECT ga.account_code, jl.debit::numeric AS debit, jl.credit::numeric AS credit
       FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE jl.journal_entry_id=$1 AND jl.company_id=$2 ORDER BY ga.account_code`,
      [entryId, a.company]);
    // The contra revenue is closed with a CREDIT, never a negative debit.
    expect(lines.rows.map((r) => ({
      code: r.account_code, debit: Number(r.debit), credit: Number(r.credit),
    }))).toEqual([
      { code: '3200', debit: 700, credit: 0 },  // the loss lands as a debit to equity
      { code: '4000', debit: 0, credit: 500 },
      { code: '5000', debit: 0, credit: 200 },
    ]);

    const totals = await pool.query(
      'SELECT SUM(debit)::numeric d, SUM(credit)::numeric c FROM gl_journal_lines WHERE journal_entry_id=$1 AND company_id=$2',
      [entryId, a.company]);
    expect(Number(totals.rows[0].d)).toBe(Number(totals.rows[0].c));

    // Retained earnings now carries the year's result and the P&L is flat.
    const balances = await pool.query(
      `SELECT ga.account_code,
              SUM(jl.debit - jl.credit)::numeric AS net_debit
       FROM gl_journal_lines jl
       JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
       WHERE jl.company_id=$1 AND ga.account_code IN ('3200','4000','5000')
       GROUP BY ga.account_code ORDER BY ga.account_code`,
      [a.company]);
    expect(balances.rows.map((r) => [r.account_code, Number(r.net_debit)])).toEqual([
      ['3200', 700],   // equity debited by the loss
      ['4000', 0],
      ['5000', 0],
    ]);

    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2', [a.company, '2025']);
    expect(periods.rows.map((r) => r.status)).toEqual(['locked']);
  });

  it('leaves the second tenant completely untouched', async () => {
    const other = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [b.company]);
    expect(other.rows[0].n).toBe(0);
    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1', [b.company]);
    expect(periods.rows.map((r) => r.status)).toEqual(['closed']);
  });

  it('reports the existing journal on a second close instead of posting twice', async () => {
    // The first close flattens the P&L, so a re-run's aggregates are empty and
    // it lands on the same branch a DORMANT year takes. Without the
    // already-closed lookup it would answer "closed, nothing to post" and hide
    // that the real close happened earlier, so the two are told apart.
    //
    // K-113 (the missing already-closed guard on the whole close) is a
    // separate, UNFIXED finding: the dry run of a closed year still reports a
    // false zero. What is pinned here is only that the live re-run writes no
    // second journal and does not misreport.
    const again = await closeFiscalYear(a.company, '2025', user) as {
      alreadyClosed: boolean; periodsLocked: number;
      closingEntry: { entry_number: string } | null; message: string;
    };
    expect(again.alreadyClosed).toBe(true);
    expect(again.closingEntry?.entry_number).toBe('YE-2025');
    expect(again.message).toMatch(/already closed/i);
    // periodsLocked is an OBSERVATION even here, where the call locks nothing:
    // it reports the periods that carry `locked`, read back from the table.
    const stillLocked = await pool.query(
      "SELECT count(*)::int AS n FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2 AND status='locked'",
      [a.company, '2025']);
    expect(again.periodsLocked).toBe(stillLocked.rows[0].n);

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [a.company]);
    expect(count.rows[0].n).toBe(1);
  });
});

describe('year-end close with a contra expense account (tenant B)', () => {
  it('closes a credit-balance expense account with a DEBIT and still balances', async () => {
    // Net income = revenue 1000 - expenses (-300) = 1300.
    const result = await closeFiscalYear(b.company, '2025', user) as { netIncome: number; closingEntry: { id: string } };
    expect(result.netIncome).toBe(1300);

    const lines = await pool.query(
      `SELECT ga.account_code, jl.debit::numeric AS debit, jl.credit::numeric AS credit
       FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE jl.journal_entry_id=$1 AND jl.company_id=$2 ORDER BY ga.account_code`,
      [result.closingEntry.id, b.company]);
    expect(lines.rows.map((r) => ({
      code: r.account_code, debit: Number(r.debit), credit: Number(r.credit),
    }))).toEqual([
      { code: '3200', debit: 0, credit: 1300 },
      { code: '4000', debit: 1000, credit: 0 },
      { code: '5000', debit: 300, credit: 0 },  // contra expense closed with a debit
    ]);

    const totals = await pool.query(
      'SELECT SUM(debit)::numeric d, SUM(credit)::numeric c FROM gl_journal_lines WHERE journal_entry_id=$1 AND company_id=$2',
      [result.closingEntry.id, b.company]);
    expect(Number(totals.rows[0].d)).toBe(1300 + 1000 + 300 - 1300);
    expect(Number(totals.rows[0].d)).toBe(Number(totals.rows[0].c));
  });
});

describe('a year with nothing to transfer still closes', () => {
  it('closes a BREAK-EVEN year without a zero retained-earnings line (tenant C)', async () => {
    // netIncome is exactly 0. Appending a `debit: 0, credit: 0` line to say so
    // makes the journal illegal — validateJournalEntry requires a non-zero
    // amount on exactly one side of every line — so the close refused a
    // perfectly balanced journal. The P&L lines already offset each other.
    const result = await closeFiscalYear(c.company, '2025', user) as
      { netIncome: number; alreadyClosed: boolean; closingEntry: { id: string } };
    expect(result.netIncome).toBe(0);
    expect(result.alreadyClosed).toBe(false);

    const lines = await pool.query(
      `SELECT ga.account_code, jl.debit::numeric AS debit, jl.credit::numeric AS credit
       FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE jl.journal_entry_id=$1 AND jl.company_id=$2 ORDER BY ga.account_code`,
      [result.closingEntry.id, c.company]);
    expect(lines.rows.map((r) => ({
      code: r.account_code, debit: Number(r.debit), credit: Number(r.credit),
    }))).toEqual([
      { code: '4000', debit: 1000, credit: 0 },
      { code: '5000', debit: 0, credit: 1000 },
    ]);
    // No retained-earnings line at all, and the journal still balances.
    expect(lines.rows.map((r) => r.account_code)).not.toContain('3200');

    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2', [c.company, '2025']);
    expect(periods.rows.map((r) => r.status)).toEqual(['locked']);
  });

  it('closes a DORMANT year with no journal at all, and still locks it (tenant D)', async () => {
    // Nothing was posted to any P&L account, so there are no lines and there is
    // no such thing as a legal empty journal. The year must still close: a
    // company that traded not at all would otherwise carry it open forever.
    const result = await closeFiscalYear(d.company, '2025', user) as
      { netIncome: number; closingEntry: null; periodsLocked: number; alreadyClosed: boolean; message: string };
    expect(result.netIncome).toBe(0);
    expect(result.closingEntry).toBeNull();
    expect(result.alreadyClosed).toBe(false);
    // COUNTED from the lock UPDATE, then agreed with the table. The literal
    // `true` this replaced was an assertion about a statement nobody read.
    const lockedNow = await pool.query(
      "SELECT count(*)::int AS n FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2 AND status='locked'",
      [d.company, '2025']);
    expect(result.periodsLocked).toBe(1);
    expect(result.periodsLocked).toBe(lockedNow.rows[0].n);
    expect(result.message).toMatch(/no posted profit or loss/i);

    const written = await pool.query(
      'SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1', [d.company]);
    expect(written.rows[0].n).toBe(0);

    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2', [d.company, '2025']);
    expect(periods.rows.map((r) => r.status)).toEqual(['locked']);
  });
});

describe('the close does NOT refuse a deactivated account (tenant E)', () => {
  it('posts the closing line to a WITHDRAWN revenue account and zeroes it', async () => {
    // The canonical posting path refuses a line on an inactive account
    // (journalEntryPostingService.assertNoInactiveAccountLines). The close is
    // exempt ON PURPOSE: closing a withdrawn account is precisely how its
    // balance gets zeroed, and refusing would strand the tenant — the account
    // cannot be cleared without the close and cannot be closed without being
    // reactivated first, every year, forever. That exemption was written down
    // in three places and pinned by none, so a future reader following
    // assertNoInactiveAccountLines' own docstring ("both must still enforce
    // this") could take year-end close away from every tenant carrying a
    // withdrawn P&L account with the suite still green. This is the test that
    // goes red.
    const inactive = await pool.query(
      'SELECT is_active FROM gl_accounts WHERE id=$1 AND company_id=$2', [e.revenue, e.company]);
    expect(inactive.rows[0].is_active).toBe(false);

    const result = await closeFiscalYear(e.company, '2025', user) as
      { netIncome: number; closingEntry: { id: string } };
    expect(result.netIncome).toBe(1000);

    const lines = await pool.query(
      `SELECT ga.account_code, ga.is_active, jl.debit::numeric AS debit, jl.credit::numeric AS credit
       FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE jl.journal_entry_id=$1 AND jl.company_id=$2 ORDER BY ga.account_code`,
      [result.closingEntry.id, e.company]);
    expect(lines.rows.map((r) => ({
      code: r.account_code, active: r.is_active, debit: Number(r.debit), credit: Number(r.credit),
    }))).toEqual([
      { code: '3200', active: true, debit: 0, credit: 1000 },
      { code: '4000', active: false, debit: 1000, credit: 0 },
    ]);
  });
});

describe('a REVERSED closing journal is not a close (tenant F)', () => {
  it('refuses in its own vocabulary instead of claiming the year is already closed', async () => {
    const first = await closeFiscalYear(f.company, '2025', user) as
      { closingEntry: { id: string }; alreadyClosed: boolean };
    expect(first.alreadyClosed).toBe(false);

    // The closing journal is reversed and the periods are re-opened to
    // 'closed', which is the state an admin correction leaves behind.
    await pool.query("UPDATE gl_journal_entries SET status='reversed' WHERE id=$1 AND company_id=$2",
      [first.closingEntry.id, f.company]);
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND fiscal_year=$2",
      [f.company, '2025']);

    // Without the status distinction this answered `alreadyClosed: true` for a
    // year that is NOT closed, and — because that path writes nothing and locks
    // nothing — the year could never be closed again through this service.
    // Matching only on `status='posted'` instead would send it to the INSERT,
    // where uq_gl_je_company_entry_number raises a raw 23505 the caller cannot
    // read. Both halves are wrong; the refusal is typed and names the row.
    const again = await closeFiscalYear(f.company, '2025', user) as
      { error: string; entryNumber: string; entryId: string; status: string };
    expect(again.error).toBe('closing_journal_not_posted');
    expect(again.entryNumber).toBe('YE-2025');
    expect(again.entryId).toBe(first.closingEntry.id);
    expect(again.status).toBe('reversed');

    // The dry run refuses identically: it must not promise a close that the
    // unique index cannot let happen.
    const dry = await closeFiscalYear(f.company, '2025', user, { dryRun: true }) as { error: string };
    expect(dry.error).toBe('closing_journal_not_posted');

    // Nothing was written and nothing was locked by the refusal.
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [f.company]);
    expect(count.rows[0].n).toBe(1);
    const periods = await pool.query(
      'SELECT DISTINCT status FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2', [f.company, '2025']);
    expect(periods.rows.map((r) => r.status)).toEqual(['closed']);
  });
});
