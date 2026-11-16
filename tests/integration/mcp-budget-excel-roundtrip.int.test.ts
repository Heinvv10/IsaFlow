/**
 * ROUND-TRIP GATE (MCP budget tools PR 2): get_budget_template → fill a FULL year (every row, every month, a
 * budgeted zero among them) → import_budget_workbook dry run, then live with its plan_hash → get_budget →
 * budget_variance. Every account and month ties to the cent in get_budget and in budget_variance (one call per
 * month), every row's FY total ties to the year's budget_variance, and the template's section totals tie to
 * budget_variance's revenue / expense / net profit budget. Run for the JSON grid and for the .xlsx.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { body, mcp } from './helpers/mcpBudgetFixture';
import { editXlsx, gridRows } from './helpers/mcpBudgetExcelFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');

let w: GridWorld;
beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

const cents = (text: string) => Math.round(Number(text) * 100);
const decimal = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const key = () => crypto.randomUUID();

/** Every page of get_budget: account code → month → cents. */
async function budgetOf(v: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  let offset: number | null = 0;
  while (offset !== null) {
    const page = body(await mcp(pool, w.u, 'get_budget', { version_id: v, limit: 80, offset }));
    for (const r of page.rows as Array<{ account: string; level: string; months: Record<string, string> }>) {
      expect(r.level).toBe('company');
      out.set(r.account, new Map(Object.entries(r.months).map(([m, a]) => [m, cents(a)])));
    }
    offset = page.next_offset as number | null;
  }
  return out;
}

async function variance(v: string, from: string, to: string) {
  const r = body(await mcp(pool, w.u, 'budget_variance', { period_start: `${from}-01`, period_end: lastDay(to), version_id: v, detail: 'full' }));
  const rows = new Map((r.rows as Array<{ account_code: string; budget_amount: number }>).map((x) => [x.account_code, Math.round(x.budget_amount * 100)]));
  const s = r.sections as Record<'revenue' | 'expense' | 'net_profit', { budget: number }>;
  return { rows, revenue: Math.round(s.revenue.budget * 100), expense: Math.round(s.expense.budget * 100), net: Math.round(s.net_profit.budget * 100) };
}

describe('template → full year → import → get_budget → budget_variance', () => {
  it.each(['json', 'xlsx'] as const)('%s: every account and month ties to the cent; the template totals tie to budget_variance', async (format) => {
    const v = await fx.version(w);
    const { rows, token } = await gridRows(pool, w.u, v);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // A deterministic full year: different cents in every cell, one budgeted zero.
    const want = new Map<string, Map<string, number>>();
    rows.forEach((r, i) => want.set(r.account, new Map(w.months.map((m, j) => [m, i === 0 && j === 0 ? 0 : (i + 1) * 100_003 + j * 1_237 + ((i * 7 + j * 3) % 97)]))));
    for (const r of rows) for (const [m, c] of want.get(r.account)!) r.months[m] = decimal(c);

    let args: Record<string, unknown>;
    if (format === 'json') args = { rows, version_token: token };
    else {
      const t = body(await mcp(pool, w.u, 'get_budget_template', { version_id: v, format: 'xlsx' }));
      args = { file_base64: await editXlsx(String(t.file_base64), (ws) => { for (const [a, months] of want) for (const [m, c] of months) ws.set(a, m, c / 100); }) };
    }
    const dry = body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, ...args, dry_run: true, idempotency_key: key() }));
    expect(dry).toMatchObject({ ready: true, counts: { added: rows.length * 12, refused: 0 } });
    expect(await fx.cells(v)).toEqual([]);
    expect(body(await mcp(pool, w.u, 'import_budget_workbook', { version_id: v, ...args, plan_hash: dry.plan_hash, idempotency_key: key() })))
      .toMatchObject({ saved: rows.length * 12 });

    expect(await budgetOf(v)).toEqual(want);

    const after = await gridRows(pool, w.u, v);
    for (const r of after.rows) {
      expect(Object.fromEntries(Object.entries(r.months).map(([m, a]) => [m, cents(String(a))]))).toEqual(Object.fromEntries(want.get(r.account)!));
      expect(cents(String(r.fy_total))).toBe([...want.get(r.account)!.values()].reduce((s, c) => s + c, 0));
    }
    const year = await variance(v, w.months[0]!, w.months[11]!);
    for (const [a, months] of want) expect(year.rows.get(a), a).toBe([...months.values()].reduce((s, c) => s + c, 0));
    const t = (k: string) => cents(after.totals[k]!.year);
    expect(year.revenue).toBe(t('turnover') + t('otherIncome'));
    expect(year.expense).toBe(t('costOfSales') + t('operatingExpenses') + t('otherExpenses'));
    expect(year.net).toBe(t('netProfit'));
    for (const [j, m] of w.months.entries()) {
      const month = await variance(v, m, m);
      for (const [a, months] of want) expect(month.rows.get(a), `${a} ${m}`).toBe(months.get(m));
      expect(month.net).toBe(cents(after.totals.netProfit!.months[j]!));
    }
  });
});
