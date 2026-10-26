/**
 * Budgets P2 PR-B, the Excel round-trip (spec 9, invariant 3): GET budget-grid/template and POST
 * budget-grid/import-preview called as real members through withAuth. Template -> import of the
 * same file is no change; blank is "not budgeted" and 0 a budgeted zero; month columns are found by
 * their header TEXT; rows absent from the file are untouched; a formula cell counts its cached
 * result; bad rows are errors (the rest still diff); a wrong file is refused whole; the preview
 * writes nothing and its cells + token commit through the save route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import {
  budgetSheet, cellValue, col, downloadTemplate, editWorkbook, rowOf, setCell, swapColumns, uploadPreview, zipBomb,
} from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');

interface Issue { row: number; column: string; message: string }
interface Preview {
  updatedAt: string;
  changes: Array<{ key: string; before: number | null; after: number | null }>;
  cells: Array<{ glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; month: string; amount: number | null }>;
  counts: { added: number; changed: number; cleared: number; unchanged: number };
  errors: Issue[];
  warnings: Issue[];
  totals: { before: { fy: Record<string, number> }; after: { fy: Record<string, number> } };
}

let A: GridCo, B: GridCo, Big: GridCo;
let v: string, vOther: string, vCommit: string, vB: string, vBig: string;

async function template(c: GridCo, versionId: string, grain = 'company'): Promise<Buffer> {
  const r = await downloadTemplate(templateRoute, c.owner, { version_id: versionId, grain });
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  return r.file!;
}
async function preview(c: GridCo, versionId: string, file: Buffer, who: 'owner' | 'viewer' = 'owner') {
  return uploadPreview(previewRoute, c[who], versionId, file);
}
async function ok(c: GridCo, versionId: string, file: Buffer): Promise<Preview> {
  const r = await preview(c, versionId, file);
  expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
  return r.body.data as unknown as Preview;
}
const versionRows = async (id: string) => (await pool.query(
  `SELECT gl_account_id, cc1_id, to_char(month, 'YYYY-MM') AS m, amount::text AS amount FROM budget_month_amounts WHERE version_id = $1 ORDER BY 1, 2, 3`, [id])).rows;

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  const a = A.acct;
  v = await fx.version(A, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
  await fx.amounts(A, v, a.sales, FY27, 1000);
  await fx.amounts(A, v, a.cos, FY27.slice(0, 6), 400.5);
  await fx.amounts(A, v, a.rent, FY27, 100, { cc1: A.cc1 });
  await fx.amounts(A, v, a.rent, FY27, 50, { cc1: A.cc1b });
  await fx.amounts(A, v, a.childA, FY27.slice(0, 3), 30);
  await fx.amount(A, v, a.header, '2026-03', 7); // a legacy header budget
  await fx.amount(A, v, a.inactive, '2026-03', 11); // inactive, holds an amount
  await fx.amount(A, v, a.otherIncome, '2026-03', 0); // a budgeted zero
  vOther = await fx.version(A, { fy: 2027, name: 'Scenario' });
  vCommit = await fx.version(A, { fy: 2027, name: 'Commit' });
  await fx.amounts(A, vCommit, a.sales, FY27, 500);
  vB = await fx.version(B, { fy: 2027, name: 'B' });

  // 5 000 CC1 members and one budgetable account: a 5 002-row CC1 template.
  Big = await fx.company();
  await pool.query(`UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND id <> $2`, [Big.id, Big.acct.sales]);
  await pool.query(
    `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active)
     SELECT gen_random_uuid(), $1, 'M' || lpad(g::text, 5, '0'), 'Member ' || g, 'cc1', true FROM generate_series(1, 5000) g`, [Big.id]);
  vBig = await fx.version(Big, { fy: 2027, name: 'Big' });
}, 180000);

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

describe('budget-grid template', () => {
  it('is a Budget sheet with text month headers, blank = not budgeted, 0 = budgeted zero, and hidden _meta', async () => {
    const r = await downloadTemplate(templateRoute, A.viewer, { version_id: v, grain: 'company' });
    expect(r.status).toBe(200);
    expect(String(r.headers.get('content-type'))).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.file! as unknown as ArrayBuffer);
    const ws = budgetSheet(wb);
    expect(ws.getRow(1).values).toEqual([undefined, 'Section', 'Account code', 'Account name', ...FY27, 'FY total', 'PY actual']);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(cellValue(ws, '4000', '2026-03')).toBe(1000);
    expect(cellValue(ws, '4900', '2026-03')).toBe(0);
    expect(cellValue(ws, '4900', '2026-04')).toBeNull();
    expect(cellValue(ws, '5000', '2026-09')).toBeNull();
    expect(ws.getRow(rowOf(ws, '4000')).getCell(col(ws, '2026-03')).numFmt).toBe('#,##0.00');
    expect(() => rowOf(ws, '6000')).toThrow(); // rent is budgeted by CC1: not on the company template
    expect(rowOf(ws, '6100')).toBeGreaterThan(1); // a header holding its own amounts is
    const meta = wb.getWorksheet('_meta')!;
    expect(meta.state).toBe('hidden');
    expect(meta.getRow(1).values).toEqual([undefined, 'versionId', v]);
    expect(wb.getWorksheet('Instructions')).toBeDefined();
  });

  it('another company\'s version is 404; a bad grain is 400', async () => {
    expect((await downloadTemplate(templateRoute, A.owner, { version_id: vB, grain: 'company' })).status).toBe(404);
    expect((await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'region' })).status).toBe(400);
  });
});

describe('budget-grid import-preview', () => {
  it('invariant 3: template -> import of the same file is no change (company and CC1 grain), and writes nothing', async () => {
    const before = await versionRows(v);
    const company = await ok(A, v, await template(A, v));
    expect(company.changes).toEqual([]);
    expect(company.cells).toEqual([]);
    expect(company.errors).toEqual([]);
    expect(company.counts).toMatchObject({ added: 0, changed: 0, cleared: 0 });
    expect(company.counts.unchanged).toBeGreaterThanOrEqual(7 * 12);
    expect(company.warnings.map((w) => w.message).join(' ')).toMatch(/header/i);
    expect(company.warnings.map((w) => w.message).join(' ')).toMatch(/inactive/i);
    const cc1 = await ok(A, v, await template(A, v, 'cc1'));
    expect(cc1.changes).toEqual([]);
    expect(cc1.errors).toEqual([]);
    expect(await versionRows(v)).toEqual(before);
  });

  it('diffs edits: changed, cleared (blank), added (0 and kit-parsed text); absent rows untouched', async () => {
    const file = await editWorkbook(await template(A, v), (wb) => {
      const ws = budgetSheet(wb);
      setCell(ws, '4000', '2026-03', 1500);
      setCell(ws, '5000', '2026-04', null);
      setCell(ws, '6120', '2026-05', 0);
      setCell(ws, '6120', '2026-06', 'R 1 234,50');
      ws.spliceRows(rowOf(ws, '6110'), 1); // childA's row removed: its 30s stay
    });
    const p = await ok(A, v, file);
    expect(p.counts).toMatchObject({ added: 2, changed: 1, cleared: 1 });
    const a = A.acct;
    expect(p.cells).toEqual(expect.arrayContaining([
      { glAccountId: a.sales, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1500 },
      { glAccountId: a.cos, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: null },
      { glAccountId: a.childB, cc1Id: null, cc2Id: null, buId: null, month: '2026-05', amount: 0 },
      { glAccountId: a.childB, cc1Id: null, cc2Id: null, buId: null, month: '2026-06', amount: 1234.5 },
    ]));
    expect(p.cells).toHaveLength(4);
    expect(p.changes.find((c) => c.key === `${a.sales}||||2026-03`)).toEqual({ key: `${a.sales}||||2026-03`, before: 1000, after: 1500 });
    expect(p.totals.after.fy.turnover - p.totals.before.fy.turnover).toBe(500);
  });

  it('a formula cell counts its cached result', async () => {
    const file = await editWorkbook(await template(A, v), (wb) => {
      setCell(budgetSheet(wb), '4000', '2026-03', { formula: '1000*2', result: 2000 });
    });
    const p = await ok(A, v, file);
    expect(p.changes).toEqual([{ key: `${A.acct.sales}||||2026-03`, before: 1000, after: 2000 }]);
  });

  it('matches month columns by header text, not position', async () => {
    const file = await editWorkbook(await template(A, v), (wb) => {
      const ws = budgetSheet(wb);
      swapColumns(ws, col(ws, '2026-03'), col(ws, '2027-02'));
    });
    const p = await ok(A, v, file);
    expect(p.changes).toEqual([]);
  });

  it('bad rows are errors and are left out; the valid rows still diff', async () => {
    const file = await editWorkbook(await template(A, v), (wb) => {
      const ws = budgetSheet(wb);
      setCell(ws, '5000', '2026-04', 401);
      setCell(ws, '4000', '2026-04', 999);
      setCell(ws, '6110', '2026-03', 'abc');
      setCell(ws, '6120', 'Account code', '9999');
      const width = ws.getRow(1).cellCount;
      const sales = ws.getRow(rowOf(ws, '4000'));
      ws.addRow(Array.from({ length: width }, (_, i) => sales.getCell(i + 1).value)); // a duplicate row
      ws.addRow(['Operating Expenses', '6000', 'Rent', 5]); // rent is budgeted by CC1 in this version
    });
    const p = await ok(A, v, file);
    const at = (column: string) => p.errors.filter((e) => e.column === column);
    expect(at('2026-03').map((e) => e.message).join()).toMatch(/abc|number|amount/i);
    expect(at('Account code').map((e) => e.message).join(' ')).toMatch(/9999/);
    // Both copies of a duplicated row are refused: neither value is known to be the one meant.
    expect(p.errors.filter((e) => /more than once/i.test(e.message))).toHaveLength(2);
    expect(p.errors.some((e) => /CC1/.test(e.message))).toBe(true);
    expect(p.errors).toHaveLength(5);
    expect(p.changes).toEqual([{ key: `${A.acct.cos}||||2026-04`, before: 400.5, after: 401 }]);
  });

  it('an unknown dimension code is an error row', async () => {
    const file = await editWorkbook(await template(A, v, 'cc1'), (wb) => {
      const ws = budgetSheet(wb);
      ws.getRow(rowOf(ws, '6000', 'GC1')).getCell(col(ws, 'Dimension code')).value = 'NOPE';
    });
    const p = await ok(A, v, file);
    expect(p.errors).toEqual([expect.objectContaining({ column: 'Dimension code', message: expect.stringMatching(/NOPE/) })]);
  });

  it('refuses a file whose month headers are not the year\'s months', async () => {
    for (const bad of ['2026-3', '2027-03']) {
      const file = await editWorkbook(await template(A, v), (wb) => {
        const ws = budgetSheet(wb);
        ws.getRow(1).getCell(col(ws, '2026-03')).value = bad;
      });
      const r = await preview(A, v, file);
      expect(r.status, bad).toBe(400);
      expect(r.body.error?.message).toMatch(/month/i);
    }
  });

  it('refuses another version\'s file and another year\'s file', async () => {
    const r = await preview(A, vOther, await template(A, v));
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/re-download/i);
    const otherYear = await editWorkbook(await template(A, v), (wb) => {
      const meta = wb.getWorksheet('_meta')!;
      meta.eachRow((row) => { if (row.getCell(1).value === 'fiscalYear') row.getCell(2).value = '2028'; });
    });
    const y = await preview(A, v, otherYear);
    expect(y.status).toBe(400);
    expect(y.body.error?.message).toMatch(/2028|year/i);
  });

  it('accepts a 5 000-row file', async () => {
    const file = await editWorkbook(await template(Big, vBig, 'cc1'), (wb) => {
      const ws = budgetSheet(wb);
      const m = col(ws, '2026-03');
      for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).getCell(m).value = r;
    });
    const p = await ok(Big, vBig, file);
    expect(p.errors).toEqual([]);
    expect(p.counts.added).toBe(5002);
    expect(p.cells).toHaveLength(5002);
  }, 300000);

  it('refuses a zip bomb', async () => {
    const r = await preview(A, v, await zipBomb(90));
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/too large/i);
  }, 120000);

  it('another company\'s version is 404; a viewer is 403', async () => {
    expect((await preview(A, vB, await template(A, v))).status).toBe(404);
    expect((await preview(A, v, await template(A, v), 'viewer')).status).toBe(403);
  });

  it('commits through the save route with the preview\'s cells and token; re-preview is then no change', async () => {
    const file = await editWorkbook(await template(A, vCommit), (wb) => {
      setCell(budgetSheet(wb), '4000', '2026-03', 750);
      setCell(budgetSheet(wb), '4000', '2026-04', null);
    });
    const p = await ok(A, vCommit, file);
    expect(p.cells).toHaveLength(2);
    // P1's token text (UTC ISO, microseconds), the same one _meta carries.
    expect(p.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    expect(wb.getWorksheet('_meta')!.getRow(4).values).toEqual([undefined, 'updatedAt', p.updatedAt]);
    const saved = await fx.call(saveRoute, '/api/accounting/budget-grid/save', A.owner, 'POST', {},
      { versionId: vCommit, expectedUpdatedAt: p.updatedAt, cells: p.cells });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
    expect((await ok(A, vCommit, file)).changes).toEqual([]);
  });
});
