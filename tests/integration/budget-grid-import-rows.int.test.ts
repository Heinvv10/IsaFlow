/**
 * Budgets P2 PR-B round 1: what the import makes of the rows and cells a user (or a chart) puts in
 * the template.
 *   - SEC-L4: text that starts with = + - @ is written neutralised (a leading apostrophe), and codes
 *     written that way still match on import.
 *   - BRK low: an account or member code with trailing spaces round-trips (codes compare trimmed).
 *   - QA-6: new amounts on a header or inactive account, a formula with no saved result, an
 *     ambiguous "1,234", a blank account code with amounts are row/cell errors; a month column
 *     twice refuses the file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { budgetSheet, col, downloadTemplate, editWorkbook, rowOf, setCell, uploadPreview } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);

interface Preview {
  changes: Array<{ key: string; before: number | null; after: number | null }>;
  errors: Array<{ row: number; column: string; message: string }>;
}

let A: GridCo, v: string;
const ids: Record<string, string> = {};

async function template(grain = 'company'): Promise<Buffer> {
  const r = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain });
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  return r.file!;
}
async function ok(file: Buffer): Promise<Preview> {
  const r = await uploadPreview(previewRoute, A.owner, v, file);
  expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
  return r.body.data as unknown as Preview;
}
const account = async (code: string, name: string) => {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $2, $3, $4, 'expense', 'debit', 3, true)`, [id, A.id, code, name]);
  ids[code] = id;
};

beforeAll(async () => {
  A = await fx.company();
  await account('=1+2', '@SUM(1)');
  await account('7100', '=HYPERLINK("http://evil.example","x")');
  await account('7000 ', 'Spaced');
  ids.cc = crypto.randomUUID();
  await pool.query(
    `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1, $2, '+GC9 ', '-Branch', 'cc1', true)`, [ids.cc, A.id]);
  v = await fx.version(A, { name: 'Rows' });
}, 120000);

afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

describe('codes and text in the template', () => {
  it('SEC-L4: text starting with = + - @ is written behind an apostrophe, as text', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await template('cc1') as unknown as ArrayBuffer);
    const ws = budgetSheet(wb);
    expect(ws.getRow(rowOf(ws, "'=1+2", "'+GC9 ")).getCell(col(ws, 'Account name')).value).toBe("'@SUM(1)");
    expect(ws.getRow(rowOf(ws, '7100', "'+GC9 ")).getCell(col(ws, 'Account name')).value).toBe('\'=HYPERLINK("http://evil.example","x")');
    expect(ws.getRow(rowOf(ws, '7100', "'+GC9 ")).getCell(col(ws, 'Dimension name')).value).toBe("'-Branch");
    const formulas: string[] = [];
    wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula) formulas.push(String(cell.formula));
    })));
    expect(formulas.length).toBeGreaterThan(0);
    expect(formulas.filter((f) => !/^SUM\([A-Z]+\d+:[A-Z]+\d+\)$/.test(f))).toEqual([]);
  });

  it.each(['company', 'cc1'])('neutralised and spaced codes round-trip at %s grain, and an edit lands on the right row', async (grain) => {
    const file = await template(grain);
    expect((await ok(file)).errors).toEqual([]);
    const dim = grain === 'cc1' ? "'+GC9 " : undefined;
    const edited = await editWorkbook(file, (wb) => {
      setCell(budgetSheet(wb), "'=1+2", '2026-03', 5, dim);
      setCell(budgetSheet(wb), '7000 ', '2026-04', 6, dim);
    });
    const p = await ok(edited);
    expect(p.errors).toEqual([]);
    const tail = grain === 'cc1' ? `|${ids.cc}||` : '|||';
    expect(p.changes).toEqual(expect.arrayContaining([
      { key: `${ids['=1+2']}${tail}|2026-03`, before: null, after: 5 },
      { key: `${ids['7000 ']}${tail}|2026-04`, before: null, after: 6 },
    ]));
    expect(p.changes).toHaveLength(2);
  });
});

describe('QA-6: row and cell errors', () => {
  it('new amounts on a header or an inactive account that hold none are row errors', async () => {
    const p = await ok(await editWorkbook(await template(), (wb) => {
      budgetSheet(wb).addRow(['Expenses', '6100', 'Premises', 5]);
      budgetSheet(wb).addRow(['Expenses', '6900', 'Old consultants', 5]);
    }));
    expect(p.errors.map((e) => e.message)).toEqual([expect.stringMatching(/6100.*header/i), expect.stringMatching(/6900/)]);
    expect(p.changes).toEqual([]);
  });

  it('a formula with no saved result, and an ambiguous "1,234", are cell errors', async () => {
    const p = await ok(await editWorkbook(await template(), (wb) => {
      setCell(budgetSheet(wb), '4000', '2026-03', { formula: '1000*2' } as ExcelJS.CellFormulaValue);
      setCell(budgetSheet(wb), '5000', '2026-04', '1,234');
    }));
    expect(p.errors).toEqual([
      expect.objectContaining({ column: '2026-03', message: expect.stringMatching(/saved result/i) }),
      expect.objectContaining({ column: '2026-04', message: expect.stringMatching(/1,234/) }),
    ]);
    expect(p.changes).toEqual([]);
  });

  it('a row with amounts and no account code is a row error', async () => {
    const p = await ok(await editWorkbook(await template(), (wb) => { budgetSheet(wb).addRow(['Expenses', null, 'x', 5]); }));
    expect(p.errors).toEqual([expect.objectContaining({ column: 'Account code', message: expect.stringMatching(/no account code/i) })]);
  });

  it('a month column twice refuses the file', async () => {
    const file = await editWorkbook(await template(), (wb) => {
      const ws = budgetSheet(wb);
      ws.getRow(1).getCell(ws.getRow(1).cellCount + 1).value = '2026-03';
    });
    const r = await uploadPreview(previewRoute, A.owner, v, file);
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/2026-03.*twice/);
  });
});
