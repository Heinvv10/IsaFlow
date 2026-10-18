/**
 * G-01: the posted year-end closing journal (source = 'year_end') must not reach any report.
 *
 * The reporting layer derives the close (trialBalanceBasis, balanceSheetService), so a real
 * journal that debits every revenue account and credits every expense account to zero is read
 * twice: the closed year's P&L printed 0, the SOCE booked the profit as Dividends, and a
 * cost-centre filtered P&L stopped footing to the total (the closing lines are untagged).
 *
 * The invariant pinned for every reader: the figures AFTER the close equal the figures BEFORE
 * it, and equal the fixture's own arithmetic (so "both zero" cannot pass). Tenant B is the
 * G-06 case: the close is reversed, then closed again; the reversal journal carries source
 * 'year_end' too, so neither it nor the second close may count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { getIncomeStatement } from '../../src/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '../../src/modules/accounting/services/reports/balanceSheetService';
import { getTrialBalanceReport } from '../../src/modules/accounting/services/gl/trialBalanceService';
import { getChangesInEquity } from '../../src/modules/accounting/services/afs/changesInEquityService';
import { getFinancialFigures } from '../../src/modules/accounting/services/gl/financialFiguresService';
import { getDimensionPnl } from '../../src/modules/accounting/services/reports/dimensionPnlService';
import { getMonthlyMovements } from '../../src/modules/accounting/services/reports/trendRowsService';
import { profitAndLossTool } from '../../src/lib/mcp/tools/reportsProfitAndLoss';
import type { McpToolContext } from '../../src/lib/mcp/types';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const FY25 = ['2025-01-01', '2025-12-31'] as const;
const FY26 = ['2026-01-01', '2026-12-31'] as const;
// FY2025: revenue 1000 + 500 + 250, expenses 400 + 300 -> profit 1050. FY2026: 600 - 200 -> 400.
const PROFIT_25 = 1050;
const PROFIT_26 = 400;

interface Tenant {
  company: string; bank: string; capital: string; retained: string; revenue: string; expense: string;
  p25: string; p26: string; ccA: string; ccB: string;
}
const tenant = (): Tenant => ({
  company: crypto.randomUUID(), bank: crypto.randomUUID(), capital: crypto.randomUUID(),
  retained: crypto.randomUUID(), revenue: crypto.randomUUID(), expense: crypto.randomUUID(),
  p25: crypto.randomUUID(), p26: crypto.randomUUID(), ccA: crypto.randomUUID(), ccB: crypto.randomUUID(),
});
const a = tenant();
const b = tenant();
const c = tenant();

async function post(t: Tenant, n: string, date: string, period: string, left: string, right: string,
  amount: number, cc: string | null = null) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'seed','manual','posted',$6,$6,now())`, [id, t.company, n, date, period, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id,cc1_id)
     VALUES($1,$2,$4,0,'seed',$5,$6),($1,$3,0,$4,'seed',$5,$6)`, [id, left, right, amount, t.company, cc]);
}

async function seed(t: Tenant, name: string) {
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [t.company, name]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'1000','Bank','asset','bank','debit',true,false),
           ($3,$2,'3000','Share capital','equity','share_capital','credit',true,false),
           ($4,$2,'3200','Retained Earnings','equity','retained_earnings','credit',true,true),
           ($5,$2,'4000','Sales','revenue','sales','credit',true,false),
           ($6,$2,'5000','Rent','expense','operating_expense','debit',true,false)`,
    [t.bank, t.company, t.capital, t.retained, t.revenue, t.expense]);
  await pool.query(
    `INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,$3,'FY2025',1,2025,'2025-01-01','2025-12-31','closed'),($2,$3,'FY2026',1,2026,'2026-01-01','2026-12-31','open')`,
    [t.p25, t.p26, t.company]);
  await pool.query(
    `INSERT INTO cost_centres(id,company_id,code,name) VALUES($1,$3,'CCA','A'),($2,$3,'CCB','B')`,
    [t.ccA, t.ccB, t.company]);
  clearSystemAccountCache(t.company);
  await post(t, 'CAP', '2025-01-02', t.p25, t.bank, t.capital, 10000);
  await post(t, 'S1', '2025-03-10', t.p25, t.bank, t.revenue, 1000, t.ccA);
  await post(t, 'S2', '2025-06-10', t.p25, t.bank, t.revenue, 500, t.ccB);
  await post(t, 'S3', '2025-09-10', t.p25, t.bank, t.revenue, 250);
  await post(t, 'X1', '2025-04-10', t.p25, t.expense, t.bank, 400, t.ccA);
  await post(t, 'X2', '2025-07-10', t.p25, t.expense, t.bank, 300);
  await post(t, 'S4', '2026-02-01', t.p26, t.bank, t.revenue, 600);
  await post(t, 'X3', '2026-03-01', t.p26, t.expense, t.bank, 200);
}

/** Every number a reader derives for the two years, as plain data. */
async function figures(t: Tenant) {
  const mcp = await profitAndLossTool.handler({ period_start: FY25[0], period_end: FY25[1] },
    { userId: user, companyId: t.company, scopes: ['read:reports'], tokenJti: null, oauthAppId: null } as McpToolContext);
  const tb = async (period: string) => (await getTrialBalanceReport(t.company, period)).rows
    .map((r) => [r.accountCode, r.debitBalance, r.creditBalance]);
  const bs = async (d: string) => { const r = await getBalanceSheet(t.company, d); return [r.totalAssets, r.totalLiabilities, r.totalEquity]; };
  const soce = await getChangesInEquity(t.company, FY25[0], FY25[1]);
  const dim = await getDimensionPnl(t.company, FY25[0], FY25[1], 'cc1');
  const ff = await getFinancialFigures(t.company, FY25[0], FY25[1]);
  const is26 = await getIncomeStatement(t.company, FY26[0], FY26[1], {}, { start: FY25[0], end: FY25[1] });
  const trend = await getMonthlyMovements(t.company, '2025-12-31');
  return {
    is25: (({ totalRevenue, netProfit }) => ({ totalRevenue, netProfit }))(await getIncomeStatement(t.company, FY25[0], FY25[1])),
    is26: { netProfit: is26.netProfit, priorNetProfit: is26.priorNetProfit, priorTotalRevenue: is26.priorTotalRevenue },
    ccA: (await getIncomeStatement(t.company, FY25[0], FY25[1], { costCentreId: t.ccA })).netProfit,
    ccB: (await getIncomeStatement(t.company, FY25[0], FY25[1], { costCentreId: t.ccB })).netProfit,
    dimColumns: dim.columns.map((c) => c.netProfit).sort((x, y) => x - y), dimTotal: dim.total.netProfit,
    bs25: await bs(FY25[1]), bs26: await bs(FY26[1]), tb25: await tb(t.p25), tb26: await tb(t.p26),
    soce: [soce.totalProfitForYear, soce.totalDividends, soce.totalClosing],
    ff: [ff.period.netProfit, ff.period.revenue, ff.cumulative.totalEquity],
    trend: trend.byAccountCode['4000'], mcp: JSON.parse(mcp.content[0]!.text),
  };
}

async function cleanup() {
  for (const t of [a, b, c]) {
    clearSystemAccountCache(t.company);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)', [t.company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [t.company]);
  }
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

let beforeA: Awaited<ReturnType<typeof figures>>;
let beforeB: Awaited<ReturnType<typeof figures>>;
let beforeC: Awaited<ReturnType<typeof figures>>;

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01-${user}@test.local`]);
  await seed(a, 'G01 tenant A');
  await seed(b, 'G01 tenant B');
  await seed(c, 'G01 tenant C');
  beforeA = await figures(a);
  beforeB = await figures(b);
  beforeC = await figures(c);
}, 120000);

afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

describe('G-01: the year-end closing journal is invisible to every report (tenant A)', () => {
  it('the fixture itself reads as the profit before the close', () => {
    expect(beforeA.is25).toEqual({ totalRevenue: 1750, netProfit: PROFIT_25 });
    expect(beforeA.is26.priorNetProfit).toBe(PROFIT_25);
    expect(beforeA.soce[0]).toBe(PROFIT_25);
    expect(beforeA.ccA + beforeA.ccB).toBe(600 + 500);
  });

  it('every figure after the close equals the figure before it', async () => {
    const closed = await closeFiscalYear(a.company, '2025', user) as { alreadyClosed: boolean; closingEntry: { id: string } };
    expect(closed.alreadyClosed).toBe(false);
    const raw = await pool.query(
      "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end' AND status='posted'", [a.company]);
    expect(raw.rows[0].n).toBe(1);

    const after = await figures(a);
    expect(after.is25).toEqual({ totalRevenue: 1750, netProfit: PROFIT_25 });
    expect(after.is26).toEqual(beforeA.is26);
    expect(after.soce[0]).toBe(PROFIT_25);
    expect(after.soce[1]).toBe(0);
    expect(after.ff[0]).toBe(PROFIT_25);
    expect(after).toEqual(beforeA);
  });

  it('the balance sheet balances and the trial balance foots at both year ends', async () => {
    for (const d of [FY25[1], FY26[1]]) {
      const bs = await getBalanceSheet(a.company, d);
      expect(Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity))).toBeLessThan(0.005);
    }
    for (const p of [a.p25, a.p26]) expect((await getTrialBalanceReport(a.company, p)).balanced).toBe(true);
    const bs26 = await getBalanceSheet(a.company, FY26[1]);
    expect(bs26.totalEquity).toBe(10000 + PROFIT_25 + PROFIT_26);
  });

  it('cost-centre columns still partition the unfiltered total', async () => {
    const dim = await getDimensionPnl(a.company, FY25[0], FY25[1], 'cc1');
    expect(dim.total.netProfit).toBe(PROFIT_25);
    expect(dim.columns.reduce((s, c) => s + c.netProfit, 0)).toBe(PROFIT_25);
    expect(dim.residual.netProfit).toBe(0);
  });

  it('the close\'s lines carry no cost centre, business unit or project, so the tag-filtered readers cannot see them', async () => {
    const tagged = await pool.query(
      `SELECT count(*)::int AS n FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
       WHERE je.company_id=$1 AND je.source='year_end'
         AND (jl.cc1_id IS NOT NULL OR jl.cc2_id IS NOT NULL OR jl.bu_id IS NOT NULL OR jl.project_id IS NOT NULL OR jl.cost_center_id IS NOT NULL)`,
      [a.company]);
    expect(tagged.rows[0].n).toBe(0);
  });

  it('the raw ledger still holds the journal (the lock and audit record)', async () => {
    const lines = await pool.query(
      `SELECT count(*)::int AS n FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
       WHERE je.company_id=$1 AND je.source='year_end'`, [a.company]);
    expect(lines.rows[0].n).toBe(3);
  });
});

describe('G-06: a reversed closing journal and a second close (tenant B)', () => {
  it('reports are unchanged by the close, its reversal and the second close', async () => {
    const first = await closeFiscalYear(b.company, '2025', user) as { closingEntry: { id: string } };
    // A reversal needs an open period; the year is re-locked after, as an admin correction leaves it.
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE id=$1", [b.p25]);
    const contra = await reverseJournalEntry(b.company, first.closingEntry.id, user);
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE id=$1", [b.p25]);
    const reversed = await pool.query('SELECT reversed_at, source FROM gl_journal_entries WHERE id=$1', [first.closingEntry.id]);
    expect(reversed.rows[0].reversed_at).not.toBeNull();
    // The contra carries the original's source, which is why one source predicate covers the pair.
    expect(contra.source).toBe('year_end');
    expect(await figures(b)).toEqual(beforeB);

    const again = await closeFiscalYear(b.company, '2025', user) as
      { alreadyClosed: boolean; closingEntry: { entry_number: string; id: string } };
    expect(again.alreadyClosed).toBe(false);
    expect(again.closingEntry.entry_number).toBe('YE-2025-R1');
    expect(await figures(b)).toEqual(beforeB);

    const third = await closeFiscalYear(b.company, '2025', user) as { alreadyClosed: boolean; closingEntry: { id: string } };
    expect(third.alreadyClosed).toBe(true);
    expect(third.closingEntry.id).toBe(again.closingEntry.id);
    const n = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [b.company]);
    expect(n.rows[0].n).toBe(3);
  }, 60000);
});

describe('G-06: reversing the reversal reinstates the close (tenant C)', () => {
  it('is reported as closed, not closed again over a flat P&L', async () => {
    const first = await closeFiscalYear(c.company, '2025', user) as { closingEntry: { id: string } };
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE id=$1", [c.p25]);
    const contra = await reverseJournalEntry(c.company, first.closingEntry.id, user);
    await reverseJournalEntry(c.company, contra.id, user);
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE id=$1", [c.p25]);
    // The original keeps reversed_at (it is a one-link marker), yet it stands again.
    const row = await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE id=$1', [first.closingEntry.id]);
    expect(row.rows[0].reversed_at).not.toBeNull();

    const again = await closeFiscalYear(c.company, '2025', user) as
      { alreadyClosed: boolean; closingEntry: { id: string; entry_number: string } };
    expect(again.alreadyClosed).toBe(true);
    expect(again.closingEntry.id).toBe(first.closingEntry.id);
    const dry = await closeFiscalYear(c.company, '2025', user, { dryRun: true }) as { alreadyClosed: boolean };
    expect(dry.alreadyClosed).toBe(true);
    // Original, its reversal and the reversal of that: three year_end journals, no empty "re-close".
    const n = await pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'", [c.company]);
    expect(n.rows[0].n).toBe(3);
    expect(await figures(c)).toEqual(beforeC);
  }, 60000);
});
