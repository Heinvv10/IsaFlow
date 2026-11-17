/**
 * ROUND-TRIP GATE, 14-month year (MCP budget tools PR 2, review rounds 1 and 2): a company whose financial year 2027
 * runs January 2026 to February 2027 after a change of year end. get_budget_template → fill all 14 months of every
 * row (revenue, other income, cost of sales, expenses, a header holding its own amounts, negative amounts, a budgeted
 * zero) → import_budget_workbook dry run, then live → get_budget ties every account (and member) and month to the
 * cent; budget_variance ties every account over the 14-month year and in each of the 14 months (per member at the
 * CC1 grain), and at company grain its revenue / expense / net profit budget equal the template's section totals.
 * Company grain as the JSON grid and as the .xlsx; CC1 grain of two members as the JSON grid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';
import { budgetOf, cents, decimal, editXlsx, gridRows, varianceOf } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridFixture(pool);
const MONTHS = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, i, 1)).toISOString().slice(0, 7)); // 2026-01 .. 2027-02

let co: GridCo;
beforeAll(async () => { co = await fx.company({ transition: true }); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [co.id]);
    await pool.query('DELETE FROM budget_write_snapshots WHERE company_id = $1', [co.id]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const REVENUE = new Set(['turnover', 'other_income']);
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, c) => s + c, 0);
const amount = (i: number, j: number) => (i === 2 && j === 13 ? 0 : (j % 4 === 1 ? -1 : 1) * ((i + 1) * 70_001 + j * 913 + i * j));

async function importAll(v: string, args: Record<string, unknown>) {
  const u = co.owner;
  const dry = body(await mcp(pool, u, 'import_budget_workbook', { version_id: v, ...args, dry_run: true, idempotency_key: crypto.randomUUID() }));
  expect(dry, JSON.stringify(dry).slice(0, 500)).toMatchObject({ ready: true, counts: { refused: 0 } });
  body(await mcp(pool, u, 'import_budget_workbook', { version_id: v, ...args, plan_hash: dry.plan_hash, idempotency_key: crypto.randomUUID() }));
}

describe('a 14-month year, end to end', () => {
  it.each(['json', 'xlsx'] as const)('%s, company grain: get_budget and budget_variance tie to the cent, per month and over the year; the totals tie', async (format) => {
    const v = await fx.version(co, { fy: 2027, name: `RT14 ${format}` });
    await fx.amount(co, v, co.acct.header, '2026-01', 55.55); // a header holding its own amounts is a row
    const u = co.owner;
    const { rows } = await gridRows(pool, u, v);
    expect(body(await mcp(pool, u, 'get_budget_template', { version_id: v, limit: 1 })).months).toEqual(MONTHS);
    expect(rows.map((r) => r.account).sort()).toEqual(['4000', '4900', '5000', '6000', '6100', '6110', '6120']);
    const want = new Map(rows.map((r, i) => [r.account, new Map(MONTHS.map((m, j) => [m, amount(i, j)]))]));
    for (const r of rows) for (const [m, c] of want.get(r.account)!) r.months[m] = decimal(c);
    await importAll(v, format === 'json' ? { rows } : {
      file_base64: await editXlsx(String(body(await mcp(pool, u, 'get_budget_template', { version_id: v, format: 'xlsx' })).file_base64),
        (ws) => { for (const [a, months] of want) for (const [m, c] of months) ws.set(a, m, c / 100); }),
    });

    expect(await budgetOf(pool, u, v)).toEqual(new Map([...want].map(([a, m]) => [`${a}|`, m])));
    const after = await gridRows(pool, u, v);
    const section = new Map(after.rows.map((r) => [r.account, String(r.section)]));
    const tot = (k: string) => cents(after.totals[k]!.year);
    const year = await varianceOf(pool, u, v, MONTHS[0]!, MONTHS[13]!);
    for (const [a, months] of want) expect(year.rows.get(a), a).toBe(sum(months));
    const rev = [...want].filter(([a]) => REVENUE.has(section.get(a)!)).reduce((s, [, m]) => s + sum(m), 0);
    const exp = [...want].filter(([a]) => !REVENUE.has(section.get(a)!)).reduce((s, [, m]) => s + sum(m), 0);
    expect([year.revenue, year.expense, year.net]).toEqual([rev, exp, tot('netProfit')]);
    expect([tot('turnover') + tot('otherIncome'), tot('costOfSales') + tot('operatingExpenses') + tot('otherExpenses')]).toEqual([rev, exp]);
    for (const [j, m] of MONTHS.entries()) {
      const month = await varianceOf(pool, u, v, m, m);
      for (const [a, months] of want) expect(month.rows.get(a), `${a} ${m}`).toBe(months.get(m));
      expect(month.net, m).toBe(cents(after.totals.netProfit!.months[j]!));
    }
  });

  it('json, cc1 grain of two members: every account, member and month ties in get_budget and, per member, in budget_variance', async () => {
    const v = await fx.version(co, { fy: 2027, name: 'RT14 cc1' });
    const u = co.owner;
    const { rows } = await gridRows(pool, u, v, 'cc1', [co.cc1, co.cc1b]);
    expect(new Set(rows.map((r) => r.dimension))).toEqual(new Set(['GC1', 'GC1B']));
    const want = new Map(rows.map((r, i) => [`${r.account}|${r.dimension}`, new Map(MONTHS.map((m, j) => [m, amount(i, j)]))]));
    for (const r of rows) for (const [m, c] of want.get(`${r.account}|${r.dimension}`)!) r.months[m] = decimal(c);
    await importAll(v, { rows, grain: 'cc1' });
    expect(await budgetOf(pool, u, v)).toEqual(want);
    for (const [id, code] of [[co.cc1, 'GC1'], [co.cc1b, 'GC1B']] as const) {
      const mine = rows.filter((x) => x.dimension === code);
      const year = await varianceOf(pool, u, v, MONTHS[0]!, MONTHS[13]!, { cc1_id: id });
      for (const r of mine) expect(year.rows.get(r.account), `${r.account}/${code}`).toBe(sum(want.get(`${r.account}|${code}`)!));
      for (const m of MONTHS) {
        const month = await varianceOf(pool, u, v, m, m, { cc1_id: id });
        for (const r of mine) expect(month.rows.get(r.account), `${r.account}/${code} ${m}`).toBe(want.get(`${r.account}|${code}`)!.get(m));
      }
    }
  });
});
