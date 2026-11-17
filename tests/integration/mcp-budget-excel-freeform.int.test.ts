/**
 * A free-form .xlsx through import_budget_workbook against a real database (review round 2): a sheet a person or an
 * agent made (a title row, a "Code" column, a description column, months headed "Mar 2026" ...), no IsaFlow _meta or
 * _base. Round trip: every account and month (negatives, a budgeted zero, a blank that keeps the version's amount)
 * → dry run → live with its plan_hash → get_budget and budget_variance tie to the cent. Overwrite: the sheet is
 * refused at a version_token older than the version; at the current one it sets every cell it names, a colleague's
 * earlier change included, keeps every blank and clears every "clear".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, type GridWorld } from './helpers/budgetGridSaveFixture';
import { body, mcp, text } from './helpers/mcpBudgetFixture';
import { budgetOf, gridRows, varianceOf } from './helpers/mcpBudgetExcelFixture';

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

const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const header = (m: string) => `${NAMES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const tokenOf = async (v: string) => String(body(await mcp(pool, w.u, 'get_budget', { version_id: v, limit: 1 })).version_token);
const imp = (args: Record<string, unknown>) => mcp(pool, w.u, 'import_budget_workbook', { idempotency_key: crypto.randomUUID(), ...args });

async function sheet(rows: Array<Array<string | number | null>>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan FY');
  ws.addRow(['Our budget, as agreed']);
  ws.addRow(['Code', 'Description', ...w.months.map(header)]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('a free-form sheet', () => {
  it('round trip: every account and month (a blank keeps the version\'s amount) ties in get_budget and budget_variance to the cent', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.sales, w.months[1]!, 20);
    const accounts = (await gridRows(pool, w.u, v)).rows.map((r) => r.account);
    const want = new Map(accounts.map((a, i) => [a, new Map(w.months.map((m, j) => [m, i === 0 && j === 1 ? 2000 : i === 1 && j === 2 ? 0 : (j % 3 === 0 ? -1 : 1) * ((i + 1) * 40_009 + j * 77)]))]));
    const rows = accounts.map((a, i) => [a, `Row ${a}`, ...w.months.map((m, j) => (i === 0 && j === 1 ? null : want.get(a)!.get(m)! / 100))]);
    expect(accounts[0]).toBe('GS-4000'); // Sales: its blank month keeps 20.00
    const args = { version_id: v, file_base64: await sheet(rows), version_token: await tokenOf(v) };
    const dry = body(await imp({ ...args, dry_run: true }));
    expect(dry).toMatchObject({ ready: true, sheet: 'free-form', counts: { refused: 0, added: accounts.length * 12 - 1 } });
    expect(String(dry.overwrite)).toMatch(/^This sheet has no base/);
    expect(text(await imp(args))).toMatch(/plan_hash is required/);
    body(await imp({ ...args, plan_hash: dry.plan_hash }));

    expect(await budgetOf(pool, w.u, v)).toEqual(new Map([...want].map(([a, m]) => [`${a}|`, m])));
    const year = await varianceOf(pool, w.u, v, w.months[0]!, w.months[11]!);
    for (const [a, months] of want) expect(year.rows.get(a), a).toBe([...months.values()].reduce((s, c) => s + c, 0));
    for (const m of w.months) {
      const month = await varianceOf(pool, w.u, v, m, m);
      for (const [a, months] of want) expect(month.rows.get(a), `${a} ${m}`).toBe(months.get(m));
    }
  });

  it('overwrite: refused at a token older than the version; at the current one every named cell is set, blanks keep, "clear" clears', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 10);
    await fx.amount(w, v, w.rent, w.months[1]!, 11);
    await fx.amount(w, v, w.sales, w.months[0]!, 30);
    const t0 = await tokenOf(v);
    expect((await fx.call(w.u, { versionId: v, expectedUpdatedAt: t0, cells: [{ glAccountId: w.rent, month: w.months[0]!, amount: 999 }] })).status).toBe(200);
    const file = await sheet([['BR-5000', 'Rent', 55, ...w.months.slice(1).map(() => null)], ['GS-4000', 'Sales', 'clear', ...w.months.slice(1).map(() => null)]]);
    const before = await fx.cells(v);
    expect(text(await imp({ version_id: v, file_base64: file, version_token: t0, dry_run: true }))).toMatch(/^This budget was saved after the version_token this sheet was sent with/);
    expect(text(await imp({ version_id: v, file_base64: file, dry_run: true }))).toMatch(/^This workbook is a free-form sheet/);
    expect(await fx.cells(v)).toEqual(before);
    const t1 = await tokenOf(v);
    const dry = body(await imp({ version_id: v, file_base64: file, version_token: t1, dry_run: true }));
    expect(dry).toMatchObject({ conflict_count: 0, counts: { changed: 1, removed: 1, added: 0 } });
    body(await imp({ version_id: v, file_base64: file, version_token: t1, plan_hash: dry.plan_hash }));
    expect((await fx.cells(v)).sort()).toEqual([`${w.rent}||||${w.months[0]}=55.00`, `${w.rent}||||${w.months[1]}=11.00`].sort());
  });
});
