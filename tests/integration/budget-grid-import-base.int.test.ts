/**
 * Budgets P2 PR-B round 1, ruling R1 (breaker H1): the import is a 3-way diff against the values
 * the template was cut with (the hidden, protected `_base` sheet), never a 2-way diff against the
 * version as it is now. A cell the user left as downloaded is untouched, even where a colleague
 * has saved since (no silent revert); a cell the user changed that a colleague also changed is a
 * CONFLICT, listed and still applied as the user's value (PR-A rebaseDirty's rule); a newer token
 * is a warning naming how many cells moved. A `_base` that is unparseable, forged (Q4: _meta signs
 * it with a server HMAC) or contradicts the version at the same token is refused 400, telling the
 * user to download a fresh template and make their changes in it (Q3a: never to re-enter old
 * values). Q3b: a file with no `_base` is previewed against the current values, every change
 * flagged `possibleRevert`, with a warning. Q3c: every change carries `currentChangedAt`. Also the
 * token chain: preview token -> save -> read -> save -> P1 status route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import readRoute from '../../pages/api/accounting/budget-grid/index';
import statusRoute from '../../pages/api/accounting/budget-versions/[id]/status';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { baseSheet, budgetSheet, col, downloadTemplate, editWorkbook, rowOf, setCell, uploadPreview } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');

interface Preview {
  updatedAt: string;
  changes: Array<{ key: string; before: number | null; after: number | null; possibleRevert?: boolean; currentChangedAt?: string | null }>;
  cells: Array<{ glAccountId: string; month: string; amount: number | null }>;
  conflicts: Array<{ key: string; downloaded: number | null; current: number | null; after: number | null }>;
  counts: { added: number; changed: number; cleared: number; unchanged: number };
  errors: Array<{ row: number; column: string; message: string }>;
  warnings: Array<{ row: number; column: string; message: string }>;
}

let A: GridCo;
const key = (acct: string, month: string) => `${acct}||||${month}`;
async function template(versionId: string, grain = 'company'): Promise<Buffer> {
  const r = await downloadTemplate(templateRoute, A.owner, { version_id: versionId, grain });
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  return r.file!;
}
async function ok(versionId: string, file: Buffer): Promise<Preview> {
  const r = await uploadPreview(previewRoute, A.owner, versionId, file);
  expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
  return r.body.data as unknown as Preview;
}
async function refused(versionId: string, file: Buffer): Promise<string> {
  const r = await uploadPreview(previewRoute, A.owner, versionId, file);
  expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(400);
  return r.body.error?.message ?? '';
}
const token = async (id: string) => String((await pool.query(
  `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t FROM budget_versions WHERE id = $1`, [id])).rows[0].t);
const save = (versionId: string, expectedUpdatedAt: string, cells: unknown[]) =>
  fx.call(saveRoute, '/api/accounting/budget-grid/save', A.owner, 'POST', {}, { versionId, expectedUpdatedAt, cells });
const colleague = async (versionId: string, cells: Array<{ acct: string; month: string; amount: number | null }>) => {
  const r = await save(versionId, await token(versionId), cells.map((c) => ({ glAccountId: c.acct, cc1Id: null, cc2Id: null, buId: null, month: c.month, amount: c.amount, ...(c.amount === null ? { clear: true } : {}) })));
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
};
const amountNow = async (versionId: string, acct: string, month: string) => (await pool.query(
  `SELECT amount::text v FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2 AND month = $3 AND cc1_id IS NULL`,
  [versionId, acct, `${month}-01`])).rows[0]?.v ?? null;

/** A version with Sales 1 000 in every month, and its template downloaded now. */
async function downloaded(name: string): Promise<{ v: string; file: Buffer }> {
  const v = await fx.version(A, { name });
  await fx.amounts(A, v, A.acct.sales, FY27, 1000);
  return { v, file: await template(v) };
}

beforeAll(async () => { A = await fx.company(); }, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

describe('R1: the import diffs against the downloaded values (_base)', () => {
  it('breaker I1: a colleague\'s save after the download survives the commit; the preview warns', async () => {
    const { v, file } = await downloaded('I1');
    await colleague(v, [{ acct: A.acct.sales, month: FY27[0]!, amount: 5000 }]);
    const edited = await editWorkbook(file, (wb) => setCell(budgetSheet(wb), '6000', FY27[1]!, 777));
    const p = await ok(v, edited);
    expect(p.changes).toEqual([{ key: key(A.acct.rent, FY27[1]!), before: null, after: 777, possibleRevert: false, currentChangedAt: null }]);
    expect(p.conflicts).toEqual([]);
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/1 cell .*changed since you downloaded/i);
    const commit = await save(v, p.updatedAt, p.cells);
    expect(commit.status, JSON.stringify(commit.body).slice(0, 300)).toBe(200);
    expect(await amountNow(v, A.acct.sales, FY27[0]!)).toBe('5000.00');
    expect(await amountNow(v, A.acct.rent, FY27[1]!)).toBe('777.00');
  });

  it('a colleague\'s clear is not undone by an untouched cell', async () => {
    const { v, file } = await downloaded('clear');
    await colleague(v, [{ acct: A.acct.sales, month: FY27[2]!, amount: null }]);
    const p = await ok(v, file);
    expect(p.changes).toEqual([]);
    expect(await amountNow(v, A.acct.sales, FY27[2]!)).toBeNull();
  });

  it('a cell both changed is a conflict, applied as the user\'s value; the same value both ways is no change', async () => {
    const { v, file } = await downloaded('conflict');
    await colleague(v, [{ acct: A.acct.sales, month: FY27[0]!, amount: 5000 }, { acct: A.acct.sales, month: FY27[1]!, amount: 2000 }]);
    const edited = await editWorkbook(file, (wb) => {
      setCell(budgetSheet(wb), '4000', FY27[0]!, 1500);
      setCell(budgetSheet(wb), '4000', FY27[1]!, 2000);
    });
    const p = await ok(v, edited);
    const mar = key(A.acct.sales, FY27[0]!);
    expect(p.conflicts).toEqual([{ key: mar, downloaded: 1000, current: 5000, after: 1500 }]);
    expect(p.changes).toEqual([{ key: mar, before: 5000, after: 1500, possibleRevert: false, currentChangedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/) }]);
    const changedAt = Date.parse(p.changes[0]!.currentChangedAt!);
    expect(Math.abs(Date.now() - changedAt)).toBeLessThan(10 * 60 * 1000);
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/2 cells .*changed since you downloaded/i);
    expect((await save(v, p.updatedAt, p.cells)).status).toBe(200);
    expect(await amountNow(v, A.acct.sales, FY27[0]!)).toBe('1500.00');
  });

  it('template -> import at the same token has no warning and no conflict', async () => {
    const { v, file } = await downloaded('same');
    const p = await ok(v, file);
    expect(p.changes).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.warnings).toEqual([]);
  });

  it('a row added to the file is diffed against blank (a new row has no downloaded values)', async () => {
    const { v, file } = await downloaded('added row');
    const edited = await editWorkbook(file, (wb) => {
      const ws = budgetSheet(wb);
      ws.spliceRows(rowOf(ws, '6000'), 1);
      const row = ws.addRow([]);
      row.getCell(col(ws, 'Account code')).value = '6000';
      row.getCell(col(ws, FY27[3]!)).value = 12;
    });
    expect((await ok(v, edited)).changes).toEqual([{ key: key(A.acct.rent, FY27[3]!), before: null, after: 12, possibleRevert: false, currentChangedAt: null }]);
  });

  it('chains the token: preview -> save -> read -> save -> P1 status route', async () => {
    const { v, file } = await downloaded('chain');
    const p = await ok(v, await editWorkbook(file, (wb) => setCell(budgetSheet(wb), '4000', FY27[0]!, 1100)));
    const first = await save(v, p.updatedAt, p.cells);
    expect(first.status).toBe(200);
    const read = await fx.call(readRoute, '/api/accounting/budget-grid', A.owner, 'GET', { version_id: v });
    expect(read.body.data!.updatedAt).toBe(first.body.data!.updatedAt);
    const second = await save(v, String(read.body.data!.updatedAt), [{ glAccountId: A.acct.sales, cc1Id: null, cc2Id: null, buId: null, month: FY27[1]!, amount: 1200 }]);
    expect(second.status, JSON.stringify(second.body).slice(0, 300)).toBe(200);
    const status = await fx.call(statusRoute, '/api/accounting/budget-versions/[id]/status', A.owner, 'POST', { id: v },
      { action: 'approve', expectedUpdatedAt: String(second.body.data!.updatedAt) });
    expect(status.status, JSON.stringify(status.body).slice(0, 300)).toBe(200);
  });
});

describe('Q3b: a file with no _base is previewed against the current values', () => {
  it('every difference is a change flagged possibleRevert, with a warning to check each one', async () => {
    const { v, file } = await downloaded('no base');
    await colleague(v, [{ acct: A.acct.sales, month: FY27[0]!, amount: 5000 }]);
    const p = await ok(v, await editWorkbook(file, (wb) => {
      wb.removeWorksheet(baseSheet(wb).id);
      setCell(budgetSheet(wb), '6000', FY27[1]!, 777);
    }));
    expect(p.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: key(A.acct.sales, FY27[0]!), before: 5000, after: 1000, possibleRevert: true }),
      expect.objectContaining({ key: key(A.acct.rent, FY27[1]!), before: null, after: 777, possibleRevert: true }),
    ]));
    expect(p.changes).toHaveLength(2);
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/no record of what you downloaded.*check each one/i);
  });
});

describe('R1 / Q4: an unparseable, forged or contradicted _base is refused', () => {
  let v: string, file: Buffer;
  beforeAll(async () => ({ v, file } = await downloaded('tamper')));
  const metaRow = (wb: import('exceljs').Workbook, k: string) => {
    const meta = wb.getWorksheet('_meta')!;
    for (let r = 1; r <= meta.rowCount; r++) if (meta.getRow(r).getCell(1).value === k) return meta.getRow(r);
    throw new Error(`no _meta ${k}`);
  };

  it.each([
    ['a non-integer amount', (ws: import('exceljs').Worksheet) => { ws.getRow(rowOf(ws, '4000')).getCell(col(ws, FY27[0]!)).value = 12.5; }],
    ['a text amount', (ws: import('exceljs').Worksheet) => { ws.getRow(rowOf(ws, '4000')).getCell(col(ws, FY27[0]!)).value = '100000'; }],
    ['a month header changed', (ws: import('exceljs').Worksheet) => { ws.getRow(1).getCell(col(ws, FY27[0]!)).value = '2025-03'; }],
    ['a row twice', (ws: import('exceljs').Worksheet) => { ws.addRow(ws.getRow(rowOf(ws, '4000')).values as unknown[]); }],
    ['a blank account code', (ws: import('exceljs').Worksheet) => { ws.getRow(rowOf(ws, '4000')).getCell(col(ws, 'Account code')).value = null; }],
    ['a value that is not the version\'s at the same token', (ws: import('exceljs').Worksheet) => { ws.getRow(rowOf(ws, '4000')).getCell(col(ws, FY27[0]!)).value = 100; }],
  ])('%s', async (_label, edit) => {
    const message = await refused(v, await editWorkbook(file, (wb) => edit(baseSheet(wb))));
    expect(message).toMatch(/download a fresh template and make your changes in it/i);
    expect(message).not.toMatch(/enter your amounts/i);
  });

  it.each([
    ['the signature removed', (wb: import('exceljs').Workbook) => { metaRow(wb, 'signature').getCell(2).value = null; }],
    ['the signature altered', (wb: import('exceljs').Workbook) => { const c = metaRow(wb, 'signature').getCell(2); const sig = String(c.value); c.value = `${sig[0] === '0' ? '1' : '0'}${sig.slice(1)}`; }],
  ])('Q4: %s', async (_label, edit) => {
    expect(await refused(v, await editWorkbook(file, edit))).toMatch(/fresh template/i);
  });

  it('Q4 / breaker J2: _base forged to the current values, with and without _meta.updatedAt, after a colleague saved', async () => {
    const { v: v2, file: f2 } = await downloaded('J2');
    await colleague(v2, [{ acct: A.acct.sales, month: FY27[0]!, amount: 5000 }]);
    const forge = (wb: import('exceljs').Workbook) => { const b = baseSheet(wb); b.getRow(rowOf(b, '4000')).getCell(col(b, FY27[0]!)).value = 500000; };
    expect(await refused(v2, await editWorkbook(f2, forge))).toMatch(/fresh template/i);
    const now = await token(v2);
    expect(await refused(v2, await editWorkbook(f2, (wb) => { forge(wb); metaRow(wb, 'updatedAt').getCell(2).value = now; }))).toMatch(/fresh template/i);
    expect(await amountNow(v2, A.acct.sales, FY27[0]!)).toBe('5000.00');
  });
});
