/**
 * ROUND-TRIP GATE (MCP budget tools PR 2): get_budget_template → fill a FULL year (every row, every month: a
 * budgeted zero, negative amounts, a header account holding its own amounts) → import_budget_workbook dry run,
 * then live with its plan_hash → get_budget → budget_variance. Every account (and member) and month ties to the
 * cent in get_budget and in budget_variance (one call per month, and the year), and the template's section totals
 * tie to budget_variance's revenue / expense / net profit budget. Company grain as the JSON grid and as the .xlsx,
 * and a CC1 grain of two members tied per member through budget_variance's cc1_id filter (the breaker's R1 and R2
 * probes, made permanent). The 14-month year is mcp-budget-excel-roundtrip14.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';
import { budgetOf, cents, decimal, editXlsx, gridRows, varianceOf } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');

let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query(`DELETE FROM budget_month_amounts WHERE company_id = $1`, [w.u.homeCompanyId]);
    await pool.query(`DELETE FROM cost_centres WHERE company_id = $1 AND code = 'GS-CCX'`, [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const key = () => crypto.randomUUID();
const REVENUE = new Set(['turnover', 'other_income']);
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, c) => s + c, 0);
/** A distinct amount for row i, month j: negative every third month, one budgeted zero. */
const amount = (i: number, j: number) => (i === 0 && j === 1 ? 0 : (j % 3 === 0 ? -1 : 1) * ((i + 1) * 100_003 + j * 1_237 + ((i * 7 + j * 3) % 97)));

async function importBoth(v: string, args: Record<string, unknown>, cellsWritten: number) {
  const dry = body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, ...args, dry_run: true, idempotency_key: key() }));
  expect(dry, JSON.stringify(dry).slice(0, 600)).toMatchObject({ ready: true, counts: { refused: 0 } });
  expect(body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, ...args, plan_hash: dry.plan_hash, idempotency_key: key() })))
    .toMatchObject({ saved: cellsWritten });
}

describe('template → full year → import → get_budget → budget_variance', () => {
  it.each(['json', 'xlsx'] as const)('%s, company grain, a header with its own amounts and negatives: every account and month ties; the totals tie', async (format) => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.header, w.months[0]!, 77.77); // a legacy header budget: the header is a row (decision 18)
    const { rows } = await gridRows(pool, w.u, v);
    expect(rows.map((r) => r.account)).toContain('GS-6000');
    const want = new Map(rows.map((r, i) => [r.account, new Map(w.months.map((m, j) => [m, amount(i, j)]))]));
    for (const r of rows) for (const [m, c] of want.get(r.account)!) r.months[m] = decimal(c);
    const args = format === 'json' ? { rows } : {
      file_base64: await editXlsx(String(body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, format: 'xlsx' })).file_base64),
        (ws) => { for (const [a, months] of want) for (const [m, c] of months) ws.set(a, m, c / 100); }),
    };
    await importBoth(v, args, rows.length * 12); // every cell written (the header's first month, 77.77, changed)

    expect(await budgetOf(pool, w.u, v)).toEqual(new Map([...want].map(([a, m]) => [`${a}|`, m])));
    const after = await gridRows(pool, w.u, v);
    const section = new Map(after.rows.map((r) => [r.account, String(r.section)]));
    for (const r of after.rows) expect(cents(String(r.fy_total)), r.account).toBe(sum(want.get(r.account)!));
    const year = await varianceOf(pool, w.u, v, w.months[0]!, w.months[11]!);
    for (const [a, months] of want) expect(year.rows.get(a), a).toBe(sum(months));
    const rev = [...want].filter(([a]) => REVENUE.has(section.get(a)!)).reduce((s, [, m]) => s + sum(m), 0);
    const exp = [...want].filter(([a]) => !REVENUE.has(section.get(a)!)).reduce((s, [, m]) => s + sum(m), 0);
    const t = (k: string) => cents(after.totals[k]!.year);
    expect([year.revenue, year.expense, year.net]).toEqual([rev, exp, t('netProfit')]);
    expect([t('turnover') + t('otherIncome'), t('costOfSales') + t('operatingExpenses') + t('otherExpenses')]).toEqual([rev, exp]);
    for (const [j, m] of w.months.entries()) {
      const month = await varianceOf(pool, w.u, v, m, m);
      for (const [a, months] of want) expect(month.rows.get(a), `${a} ${m}`).toBe(months.get(m));
      expect(month.net, m).toBe(cents(after.totals.netProfit!.months[j]!));
    }
  });

  it('json, cc1 grain, two members per account: every account, member and month ties in get_budget and in budget_variance per member, every month', async () => {
    const v = await fx.version(w);
    const other = String((await pool.query(`INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'GS-CCX', 'GS-CCX', 'cc1') RETURNING id`, [w.u.homeCompanyId])).rows[0].id);
    const members = [w.cc1, other];
    const { rows } = await gridRows(pool, w.u, v, 'cc1', members);
    expect(new Set(rows.map((r) => r.dimension))).toEqual(new Set(['GS-C1', 'GS-CCX']));
    const want = new Map(rows.map((r, i) => [`${r.account}|${r.dimension}`, new Map(w.months.map((m, j) => [m, amount(i, j)]))]));
    for (const r of rows) for (const [m, c] of want.get(`${r.account}|${r.dimension}`)!) r.months[m] = decimal(c);
    await importBoth(v, { rows, grain: 'cc1' }, rows.length * 12);
    expect(await budgetOf(pool, w.u, v)).toEqual(want);
    for (const [id, code] of [[w.cc1, 'GS-C1'], [other, 'GS-CCX']] as const) {
      const year = await varianceOf(pool, w.u, v, w.months[0]!, w.months[11]!, { cc1_id: id });
      for (const r of rows.filter((x) => x.dimension === code)) expect(year.rows.get(r.account), `${r.account}/${code}`).toBe(sum(want.get(`${r.account}|${code}`)!));
      for (const m of w.months) {
        const month = await varianceOf(pool, w.u, v, m, m, { cc1_id: id });
        for (const r of rows.filter((x) => x.dimension === code)) expect(month.rows.get(r.account), `${r.account}/${code} ${m}`).toBe(want.get(`${r.account}|${code}`)!.get(m));
      }
    }
  });
});
