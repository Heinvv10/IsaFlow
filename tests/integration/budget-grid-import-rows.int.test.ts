/**
 * Budgets P2 PR-B round 1: what the import makes of the rows and cells a user (or a chart) puts in
 * the template.
 *   - SEC-L4: text that starts with = + - @ is written neutralised (a leading apostrophe), and codes
 *     written that way still match on import.
 *   - BRK low: an account or member code with trailing spaces round-trips (codes compare trimmed).
 *   - VER-L6: codes that differ only by whitespace ("4000" and "4000 ") match exactly first, and
 *     trimmed only when the trimmed form is unique, so neither breaks the file.
 *   - SEC2-L2: a parser reason that echoes the cell is clipped.
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
  // CC1 rows: the members the tests budget (a dimension template offers held or PY-active members by default, Q1).
  const r = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain, ...(grain === 'cc1' ? { members: `${ids.cc},${A.cc1},${ids.cc1Spaced}` } : {}) });
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
  await account('4000 ', 'Sales, spaced twin'); // the fixture's Sales is '4000'
  await account("'7300", 'Apostrophe code'); // breaker J3: a code that starts with the neutralising apostrophe
  await account("''7600", 'Two apostrophes');
  ids.cc = crypto.randomUUID();
  ids.cc1Spaced = crypto.randomUUID();
  await pool.query(
    `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active)
     VALUES ($1, $3, '+GC9 ', '-Branch', 'cc1', true), ($2, $3, 'GC1 ', 'Cape Town, spaced twin', 'cc1', true)`, [ids.cc, ids.cc1Spaced, A.id]);
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
      expect.objectContaining({ key: `${ids['=1+2']}${tail}|2026-03`, before: null, after: 5 }),
      expect.objectContaining({ key: `${ids['7000 ']}${tail}|2026-04`, before: null, after: 6 }),
    ]));
    expect(p.changes).toHaveLength(2);
  });
});

describe('VER-L6: codes that differ only by whitespace', () => {
  it.each(['company', 'cc1'])('round-trip at %s grain, and each twin\'s edit lands on its own row', async (grain) => {
    const file = await template(grain);
    expect((await ok(file)).errors).toEqual([]);
    const cc1 = grain === 'cc1';
    const p = await ok(await editWorkbook(file, (wb) => {
      setCell(budgetSheet(wb), '4000', '2026-03', 1, cc1 ? 'GC1' : undefined);
      setCell(budgetSheet(wb), '4000 ', '2026-03', 2, cc1 ? 'GC1 ' : undefined);
    }));
    expect(p.errors).toEqual([]);
    expect(p.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `${A.acct.sales}|${cc1 ? A.cc1 : ''}|||2026-03`, after: 1 }),
      expect.objectContaining({ key: `${ids['4000 ']}|${cc1 ? ids.cc1Spaced : ''}|||2026-03`, after: 2 }),
    ]));
    expect(p.changes).toHaveLength(2);
  });

  it('a trimmed code still matches when only one code trims to it', async () => {
    const p = await ok(await editWorkbook(await template(), (wb) => {
      const ws = budgetSheet(wb);
      setCell(ws, '7000 ', 'Account code', '7000');
      setCell(ws, '7000', '2026-05', 4);
    }));
    expect(p.errors).toEqual([]);
    expect(p.changes.map((c) => c.key)).toEqual([`${ids['7000 ']}||||2026-05`]);
  });
});

describe('QA-6: row and cell errors', () => {
  it('SEC2-L2: a refused text amount is echoed clipped, reason included', async () => {
    const p = await ok(await editWorkbook(await template(), (wb) => { setCell(budgetSheet(wb), '5000', '2026-04', `${'1.'.repeat(1500)}5`); })); // the parser's own reason quotes the cell
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.message.length).toBeLessThan(200);
  });

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
