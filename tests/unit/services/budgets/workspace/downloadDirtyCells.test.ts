/**
 * "Download my changes (.xlsx)" (spec §7.3): the file is built in the template's format, so the
 * import's own parser (budgetImportParse) reads it back: _meta accepted, month headers matched,
 * a dirty row written whole (a blank month would clear on import), clean rows absent.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { dirtySheets, workbookFor, type DirtyExportInput } from '@/components/accounting/budgets/workspace/downloadDirtyCells';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { parseLayout, parseLines, parseMeta, type SheetRow } from '@/modules/accounting/services/budgets/budgetImportParse';
import { COLUMN } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { gridModel, ID, MONTHS, TOKEN } from '../../../components/budgets/workspace/gridFixture';

const model = gridModel();
const k = (acct: string, month: string, cc1: string | null = null) => cellKey({ glAccountId: acct, cc1Id: cc1, cc2Id: null, buId: null, month });

// rev1 held R1000 (Mar) and R0 (Apr); I typed R1 234.50 in May. dimAcc CC-B Mar edited to R25.
const current = new Map<string, number | null>([
  [k(ID.rev1, MONTHS[0]!), 100_000], [k(ID.rev1, MONTHS[1]!), 0], [k(ID.rev1, MONTHS[2]!), 123_450],
  [k(ID.cos1, MONTHS[0]!), 40_000],
  [k(ID.dimAcc, MONTHS[0]!, ID.m1), 1_000], [k(ID.dimAcc, MONTHS[0]!, ID.m2), 2_500],
]);
const input = (dirty: string[]): DirtyExportInput => ({
  versionId: ID.version, versionName: 'Original', fiscalYear: 2027, token: TOKEN, months: MONTHS,
  accounts: model.accounts, dimensions: model.dimensions, dirty,
  valueAt: (key) => current.get(key) ?? null,
});

async function readBack(buf: ArrayBuffer): Promise<Map<string, SheetRow[]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = new Map<string, SheetRow[]>();
  wb.eachSheet((ws) => {
    const rows: SheetRow[] = [];
    ws.eachRow((r, n) => {
      const values = (r.values as unknown[]).slice(1);
      rows.push({ row: n, cells: values.map((v) => (typeof v === 'number' || typeof v === 'string' ? v : null)) });
    });
    out.set(ws.name, rows);
  });
  return out;
}

describe('dirtySheets', () => {
  it('writes a dirty row whole, groups by grain, leaves clean rows out', () => {
    const { sheets, skipped } = dirtySheets(input([k(ID.rev1, MONTHS[2]!), k(ID.dimAcc, MONTHS[0]!, ID.m2)]));
    expect(skipped).toBe(0);
    expect(sheets.map((s) => s.grain)).toEqual(['company', 'cc1']);
    const [company, cc1] = sheets;
    expect(company!.rows).toHaveLength(1);
    expect(company!.rows[0]).toMatchObject({ section: 'Turnover', accountCode: '1000', dimensionCode: null });
    expect(company!.rows[0]!.months.slice(0, 4)).toEqual([1000, 0, 1234.5, null]);
    expect(cc1!.rows).toEqual([expect.objectContaining({ accountCode: '3200', dimensionCode: 'CC-B', dimensionName: 'Beta' })]);
    expect(cc1!.rows[0]!.months[0]).toBe(25);
  });

  it('a multi-dimension cell cannot be a template row and is counted', () => {
    const multi = cellKey({ glAccountId: ID.opex, cc1Id: ID.m1, cc2Id: ID.m2, buId: null, month: MONTHS[0]! });
    expect(dirtySheets(input([multi]))).toEqual({ sheets: [], skipped: 1 });
  });
});

describe('workbookFor round-trips through the import parser', () => {
  it('the company file: _meta, headers and amounts read back as the template does', async () => {
    const { sheets } = dirtySheets(input([k(ID.rev1, MONTHS[2]!)]));
    const read = await readBack(await workbookFor(ExcelJS, input([]), sheets[0]!));
    const meta = parseMeta(read.get('_meta')!);
    expect(meta).toMatchObject({ versionId: ID.version, fiscalYear: 2027, grain: 'company', updatedAt: TOKEN, signature: '' });
    expect(read.has('_base')).toBe(false);
    const budget = read.get('Budget')!;
    const layout = parseLayout(budget[0], MONTHS, 'company');
    const lines = parseLines(budget.slice(1), layout);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.accountCode).toBe('1000');
    expect(lines[0]!.amounts.slice(0, 4).map((a) => a.cell)).toEqual([
      { kind: 'value', cents: 100_000 }, { kind: 'value', cents: 0 }, { kind: 'value', cents: 123_450 }, { kind: 'blank' },
    ]);
  });

  it('the cc1 file carries the dimension code column', async () => {
    const { sheets } = dirtySheets(input([k(ID.dimAcc, MONTHS[0]!, ID.m2)]));
    const read = await readBack(await workbookFor(ExcelJS, input([]), sheets[0]!));
    expect(parseMeta(read.get('_meta')!).grain).toBe('cc1');
    const budget = read.get('Budget')!;
    const lines = parseLines(budget.slice(1), parseLayout(budget[0], MONTHS, 'cc1'));
    expect(lines.map((l) => [l.accountCode, l.dimensionCode])).toEqual([['3200', 'CC-B']]);
  });

  it('column labels match the server template', async () => {
    const { sheets } = dirtySheets(input([k(ID.dimAcc, MONTHS[0]!, ID.m2)]));
    const header = (await readBack(await workbookFor(ExcelJS, input([]), sheets[0]!))).get('Budget')![0]!.cells;
    expect(header.slice(0, 5)).toEqual([COLUMN.section, COLUMN.accountCode, COLUMN.accountName, COLUMN.dimensionCode, COLUMN.dimensionName]);
    expect(header.at(-1)).toBe(COLUMN.fyTotal);
  });
});
