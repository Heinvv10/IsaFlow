/**
 * Budgets P0 parity, against real Postgres through the real handlers: the
 * Budget vs Actual screen JSON, its CSV, MCP budget_variance and the statement
 * comparator carry the same figures to the cent, on a fixture that exercises
 * every defect D1-D14 touches:
 *   revenue budgeted under, revenue unbudgeted with movement, expense over
 *   budget, expense budgeted at exactly 0 with movement, expense with a
 *   negative budget, a level-2 expense with postings (the old export dropped
 *   it), an inactive expense with postings, a balance-sheet account with
 *   postings (never shown), a draft journal and a year_end journal (excluded).
 * Disposable schema fixture only; synthetic data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import report from '../../pages/api/accounting/reports-budget-vs-actual';
import exportCsv from '../../pages/api/accounting/budget-vs-actual-export';
import comparator from '../../pages/api/accounting/reports-budget-comparator';
import budgets from '../../pages/api/accounting/budgets';
import { budgetVarianceTool } from '@/lib/mcp/tools/budgetVariance';
import type { McpToolContext } from '@/lib/mcp/types';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture, type RouteOut } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const rep = budgetsRouteFixture(pool, report, '/api/accounting/reports-budget-vs-actual');
const csv = budgetsRouteFixture(pool, exportCsv, '/api/accounting/budget-vs-actual-export');
const cmp = budgetsRouteFixture(pool, comparator, '/api/accounting/reports-budget-comparator');
const bud = budgetsRouteFixture(pool, budgets, '/api/accounting/budgets');
let u: SetupUser;
let companyId: string;
let label: number;
let month: string; // 'YYYY-MM': the fixture's one budgeted and posted month (the year's second)
const acc: Record<string, string> = {};

interface Line {
  account_code: string; account_type: string; budgeted: boolean; budget_amount: number; actual_amount: number;
  variance: number; movement: number; variance_pct: number | null; movement_pct: number | null; favourable: boolean | null;
}
interface Section { budget: number; actual: number; variance: number; movement: number; movement_pct: number | null; favourable: boolean | null }
interface Report { period: string; start_date: string; end_date: string; lines: Line[]; sections: Record<'revenue' | 'expense' | 'net_profit', Section> }

const ACCOUNTS: Array<[string, string, string, number, boolean]> = [
  // code, type, normal balance, level, active
  ['P-1100', 'asset', 'debit', 3, true],
  ['P-3000', 'equity', 'credit', 3, true],
  ['P-4000', 'revenue', 'credit', 3, true],
  ['P-4100', 'revenue', 'credit', 3, true],
  ['P-6000', 'expense', 'debit', 3, true],
  ['P-6100', 'expense', 'debit', 3, true],
  ['P-6200', 'expense', 'debit', 3, true],
  ['P-6300', 'expense', 'debit', 2, true],
  ['P-6400', 'expense', 'debit', 3, false],
];

async function journal(date: string, lines: Array<[string, number, number]>, opts: { source?: string; status?: string } = {}) {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, description, status, source)
     VALUES ($1, $2, $3, 'p0 parity', 'draft', $4) RETURNING id`, [companyId, date, u.userId, opts.source ?? 'manual'])).rows[0];
  for (const [code, debit, credit] of lines) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
                      VALUES ($1, $2, $3, $4, $5, 'l')`, [je.id, companyId, acc[code], debit, credit]);
  }
  if ((opts.status ?? 'posted') === 'posted') {
    await pool.query(`UPDATE gl_journal_entries SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [je.id, u.userId]);
  }
}

async function budget(code: string, amount: number) {
  await pool.query(`INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount) VALUES ($1, $2, $3::date, $4)`,
    [companyId, acc[code], `${month}-01`, amount]);
}

beforeAll(async () => {
  const o = await rep.owner();
  u = o.u; companyId = u.homeCompanyId; label = o.label; month = o.months[1]!;
  for (const [code, type, normal, level, active] of ACCOUNTS) {
    acc[code] = (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [companyId, code, `Parity ${code}`, type, normal, level, active])).rows[0].id;
  }
  const d = `${month}-10`;
  await journal(d, [['P-1100', 8000, 0], ['P-4000', 0, 8000]]);      // revenue under a 10 000 budget
  await journal(d, [['P-1100', 1500, 0], ['P-4100', 0, 1500]]);      // revenue, no budget
  await journal(d, [['P-6000', 2600, 0], ['P-1100', 0, 2600]]);      // expense over a 2 000 budget
  await journal(d, [['P-6100', 700, 0], ['P-1100', 0, 700]]);        // expense budgeted at exactly 0
  await journal(d, [['P-1100', 300, 0], ['P-6200', 0, 300]]);        // contra expense, budget -500
  await journal(d, [['P-6300', 450, 0], ['P-1100', 0, 450]]);        // level-2 expense
  await journal(d, [['P-6400', 120, 0], ['P-1100', 0, 120]]);        // inactive expense
  await journal(d, [['P-6000', 5555, 0], ['P-1100', 0, 5555]], { status: 'draft' });
  await journal(d, [['P-4000', 8000, 0], ['P-3000', 0, 8000]], { source: YEAR_END_JOURNAL_SOURCE });
  await budget('P-4000', 10000);
  await budget('P-6000', 2000);
  await budget('P-6100', 0);
  await budget('P-6200', -500);
}, 60000);

afterAll(async () => {
  try {
    for (const f of [rep, csv, cmp, bud]) await f.cleanup();
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [companyId]);
  } finally { await pool.end(); }
}, 60000);

const reportOf = (r: RouteOut) => (r.body.data as unknown as { report: Report }).report;

/** Minimal RFC-4180 parse: csvVal cells are quoted; money cells are bare. */
function parseCsv(text: string): string[][] {
  return text.split('\n').map((line) => {
    const cells: string[] = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let v = ''; i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { v += '"'; i += 2; } else if (line[i] === '"') { i++; break; } else v += line[i++];
        }
        cells.push(v); i++;
      } else {
        const j = line.indexOf(',', i); const end = j === -1 ? line.length : j;
        cells.push(line.slice(i, end)); i = end + 1;
      }
    }
    return cells;
  });
}
const num = (cell: string) => (cell === '' ? null : Number(cell));
const yesNo = (f: boolean | null) => (f === null ? '' : f ? 'yes' : 'no');

async function full(): Promise<Report> {
  const r = await rep.call(u, 'GET', undefined, { period: 'full_year' });
  expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
  return reportOf(r);
}

async function mcp(start: string, end: string) {
  const ctx = { userId: u.userId, companyId, scopes: ['read:reports'], companyRole: 'owner', tokenJti: null, oauthAppId: null } as unknown as McpToolContext;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: u.userId, claims: {} } as never,
      () => budgetVarianceTool.handler({ period_start: start, period_end: end, detail: 'full' }, ctx));
    await client.query('ROLLBACK');
    return JSON.parse(out.content[0]!.text) as {
      rows: Line[]; excludedRows: Array<{ id: string; amount: number }>; totals: { budget: number; actual: number; variance: number };
      sections: Report['sections'];
    };
  } finally { client.release(); }
}

describe('budgets P0 parity on real Postgres', () => {
  it('the report carries every fixture defect correctly', async () => {
    const r = await full();
    const by = Object.fromEntries(r.lines.filter((l) => l.account_code.startsWith('P-')).map((l) => [l.account_code, l]));
    expect(Object.keys(by).sort()).toEqual(['P-4000', 'P-4100', 'P-6000', 'P-6100', 'P-6200', 'P-6300', 'P-6400']);
    expect(by['P-4000']).toMatchObject({ budgeted: true, budget_amount: 10000, actual_amount: 8000, movement: -2000, variance: -2000, favourable: false, movement_pct: -20 });
    expect(by['P-4100']).toMatchObject({ budgeted: false, actual_amount: 1500, movement: 1500, variance_pct: null, movement_pct: null, favourable: null });
    expect(by['P-6000']).toMatchObject({ budgeted: true, actual_amount: 2600, movement: 600, variance: -600, favourable: false, movement_pct: 30 });
    expect(by['P-6100']).toMatchObject({ budgeted: true, budget_amount: 0, actual_amount: 700, movement: 700, movement_pct: null, favourable: false });
    expect(by['P-6200']).toMatchObject({ budgeted: true, budget_amount: -500, actual_amount: -300, movement: 200, variance: -200, movement_pct: 40, favourable: false });
    expect(by['P-6300']).toMatchObject({ budgeted: false, actual_amount: 450 });
    expect(by['P-6400']).toMatchObject({ budgeted: false, actual_amount: 120 });
    expect(r.sections.revenue).toMatchObject({ budget: 10000, actual: 9500, movement: -500 });
    expect(r.sections.expense).toMatchObject({ budget: 1500, actual: 3570, movement: 2070 });
    expect(r.sections.net_profit).toMatchObject({ budget: 8500, actual: 5930, movement: -2570, variance: -2570, favourable: false });
    expect(r.sections.net_profit.variance).toBe(Math.round(r.lines.reduce((s, l) => s + l.variance, 0) * 100) / 100);
  });

  it('screen JSON and CSV carry identical lines, sections and net profit', async () => {
    const r = await full();
    const c = await csv.call(u, 'GET', undefined, { period: 'full_year' });
    expect(c.status).toBe(200);
    const rows = parseCsv(String(c.body));
    expect(rows[0]!.join(',')).toBe('Section,Account Code,Account Name,Budget,Actual,Variance,Variance %,Favourable');
    const lineRows = rows.slice(1).filter((x) => x[1] !== '');
    expect(lineRows.map((x) => x[1])).toEqual(r.lines.map((l) => l.account_code));
    for (const l of r.lines) {
      const x = lineRows.find((y) => y[1] === l.account_code)!;
      expect(x[0]).toBe(l.account_type === 'revenue' ? 'Revenue' : 'Expenses');
      expect(num(x[3]!)).toBe(l.budgeted ? l.budget_amount : null);
      expect(num(x[4]!)).toBe(l.actual_amount);
      expect(num(x[5]!)).toBe(l.movement);
      expect(num(x[6]!)).toBe(l.movement_pct === null ? null : Number(l.movement_pct.toFixed(2)));
      expect(x[7]).toBe(yesNo(l.favourable));
    }
    const totals = rows.slice(1).filter((x) => x[1] === '');
    expect(totals.map((x) => x[2])).toEqual(['Total revenue', 'Total expenses', 'Net profit']);
    for (const [x, s] of [[totals[0]!, r.sections.revenue], [totals[1]!, r.sections.expense], [totals[2]!, r.sections.net_profit]] as const) {
      expect([num(x[3]!), num(x[4]!), num(x[5]!), x[7]]).toEqual([s.budget, s.actual, s.movement, yesNo(s.favourable)]);
    }
  });

  it('MCP rows + excludedRows = the report\'s lines; MCP totals = report net profit', async () => {
    const r = await full();
    const m = await mcp(r.start_date, r.end_date);
    const codes = [...m.rows.map((x) => x.account_code)];
    expect(codes).toEqual(r.lines.filter((l) => l.budgeted).map((l) => l.account_code));
    expect(codes).toContain('P-6100');
    expect(m.excludedRows.map((x) => x.id).sort()).toEqual(r.lines.filter((l) => !l.budgeted).map((l) => acc[l.account_code] ?? '?').sort());
    for (const row of m.rows) {
      const l = r.lines.find((y) => y.account_code === row.account_code)!;
      expect([row.budget_amount, row.actual_amount, row.variance, row.movement, row.favourable])
        .toEqual([l.budget_amount, l.actual_amount, l.variance, l.movement, l.favourable]);
    }
    const np = r.sections.net_profit;
    expect(m.totals).toEqual({ budget: np.budget, actual: np.actual, variance: np.variance });
    expect(m.sections).toEqual(r.sections);
  });

  it('comparator budgetedCount counts the zero-budget account', async () => {
    const r = await full();
    const c = await cmp.call(u, 'GET', undefined, { period_start: r.start_date, period_end: r.end_date });
    expect(c.status, JSON.stringify(c.body).slice(0, 300)).toBe(200);
    const d = c.body.data as unknown as { budgetedCount: number; lines: Line[] };
    expect(d.budgetedCount).toBe(4);
    expect(d.lines.slice(0, 4).map((l) => l.account_code).sort()).toEqual(['P-4000', 'P-6000', 'P-6100', 'P-6200']);
  });

  it('Σ report actuals per type = Σ posted lines per type in the window (independent SQL)', async () => {
    const r = await full();
    const [start, end] = [r.start_date, r.end_date];
    const sums = (await pool.query(
      `SELECT ga.account_type,
              SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END)::float8 AS total
         FROM gl_journal_lines jl
         JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
         JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = $1 AND je.status = 'posted' AND je.source IS DISTINCT FROM 'year_end'
          AND je.entry_date BETWEEN $2 AND $3 AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.account_type`, [companyId, start, end])).rows as Array<{ account_type: string; total: number }>;
    const sql = Object.fromEntries(sums.map((s) => [s.account_type, Math.round(s.total * 100) / 100]));
    expect(r.sections.revenue.actual).toBe(sql.revenue);
    expect(r.sections.expense.actual).toBe(sql.expense);
    expect([sql.revenue, sql.expense]).toEqual([9500, 3570]);
  });

  it('period=quarter is a 400 on report and export', async () => {
    for (const f of [rep, csv]) {
      const r = await f.call(u, 'GET', undefined, { period: 'quarter' });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error?.message).toMatch(/period must be current, ytd or full_year/);
    }
  });

  it('a budget on an asset account is refused 400 and nothing is written', async () => {
    const r = await bud.call(u, 'POST', { glAccountId: acc['P-1100'], fiscalYear: label, annualAmount: 1200 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toBe('Budgets can only be set on revenue and expense accounts');
    const written = (await pool.query(
      `SELECT (SELECT count(*) FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = $2)::int AS months,
              (SELECT count(*) FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2)::int AS headers`,
      [companyId, acc['P-1100']])).rows[0];
    expect(written).toEqual({ months: 0, headers: 0 });
  });
});
