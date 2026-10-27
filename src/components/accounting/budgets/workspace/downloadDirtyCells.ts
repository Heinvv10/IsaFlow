/**
 * "Download my changes (.xlsx)" (spec §7.3): the unsaved cells, built in the browser in the
 * template's format (budgetTemplateXlsx.ts) so the file can be uploaded again through Import.
 *
 * - One workbook per grain (the import reads one grain a file); a multi-dimension row (written
 *   outside P2) cannot be expressed in a template and is left out and counted.
 * - A row that holds a dirty cell is written WHOLE (every month's current value), because the
 *   import reads a blank month as "not budgeted": writing only the dirty months would clear the
 *   rest of the row. Rows with no dirty cell are absent (absent rows are untouched on import).
 * - `_meta` names the version, year, grain and the token the edits were made from, unsigned and
 *   with no `_base` sheet (only the server can sign one): the import preview then flags every
 *   change as a possible revert, which is what the user should check after a 409.
 * exceljs is loaded on click (`import('exceljs')`, as gl-import.tsx does), never in the page bundle.
 */
import type { GridAccount, GridDimensions } from '@/modules/accounting/services/budgets/gridReadTypes';
import { type CellKey, type Dimension, grainOf, parseKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import { fromCents } from '@/modules/accounting/services/budgets/grid/cents';
import { BAND_LABEL, BAND_ORDER } from '@/modules/accounting/services/budgets/grid/subtotals';

/** The template's column labels and sheet names (budgetTemplateXlsx.ts COLUMN / sheets; the import matches them by text). */
export const TEMPLATE_TEXT = {
  sheet: 'Budget', meta: '_meta', instructions: 'Instructions', templateVersion: 1, moneyFormat: '#,##0.00',
  section: 'Section', accountCode: 'Account code', accountName: 'Account name',
  dimensionCode: 'Dimension code', dimensionName: 'Dimension name', fyTotal: 'FY total',
} as const;

export interface DirtyExportInput {
  versionId: string;
  versionName: string;
  fiscalYear: number;
  /** The token the unsaved edits were made from. */
  token: string;
  months: readonly string[];
  accounts: readonly GridAccount[];
  dimensions: GridDimensions;
  dirty: Iterable<CellKey>;
  /** A cell's current value in cents (null = cleared or never budgeted): `GridStore.valueAt`. */
  valueAt: (key: CellKey) => number | null;
}

export type ExportGrain = 'company' | Dimension;

export interface DirtyRow {
  section: string;
  accountCode: string;
  accountName: string;
  dimensionCode: string | null;
  dimensionName: string | null;
  /** Rand per month; null = blank (not budgeted). */
  months: (number | null)[];
}

export interface DirtySheet { grain: ExportGrain; rows: DirtyRow[] }

const SLOT = { cc1: 'cc1Id', cc2: 'cc2Id', bu: 'buId' } as const;
const neutralise = (text: string): string => (/^['=+\-@\t\r]/.test(text) ? `'${text}` : text);

/** The dirty rows grouped by grain, in band then account order; `skipped` counts multi-dimension cells. */
export function dirtySheets(input: DirtyExportInput): { sheets: DirtySheet[]; skipped: number } {
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const order = new Map(BAND_ORDER.flatMap((band) => input.accounts.filter((a) => a.band === band)).map((a, i) => [a.id, i]));
  const rows = new Map<string, { grain: ExportGrain; accountId: string; memberId: string | null }>();
  let skipped = 0;
  for (const key of input.dirty) {
    const ref = parseKey(key);
    const grain = grainOf(ref);
    if (grain === 'multi' || !byId.has(ref.glAccountId)) { skipped++; continue; }
    const memberId = grain === 'company' ? null : ref[SLOT[grain]];
    rows.set(rowKeyOf(key), { grain, accountId: ref.glAccountId, memberId });
  }
  const sheets: DirtySheet[] = [];
  for (const grain of ['company', 'cc1', 'cc2', 'bu'] as const) {
    const members = grain === 'company' ? new Map() : new Map(input.dimensions[grain].map((m) => [m.id, m]));
    const picked = [...rows.entries()].filter(([, r]) => r.grain === grain)
      .sort(([ka, a], [kb, b]) => (order.get(a.accountId)! - order.get(b.accountId)!) || ka.localeCompare(kb));
    if (picked.length === 0) continue;
    sheets.push({
      grain,
      rows: picked.map(([rowKey, r]) => {
        const account = byId.get(r.accountId)!;
        const member = r.memberId === null ? null : members.get(r.memberId) ?? null;
        return {
          section: BAND_LABEL[account.band], accountCode: account.code, accountName: account.name,
          dimensionCode: member?.code ?? null, dimensionName: member?.name ?? null,
          months: input.months.map((m) => { const v = input.valueAt(`${rowKey}|${m}`); return v === null ? null : fromCents(v); }),
        };
      }),
    });
  }
  return { sheets, skipped };
}

type ExcelModule = typeof import('exceljs');

/** One sheet as an .xlsx in the template's layout. */
export async function workbookFor(ExcelJS: ExcelModule, input: DirtyExportInput, sheet: DirtySheet): Promise<ArrayBuffer> {
  const T = TEMPLATE_TEXT;
  const dims = sheet.grain !== 'company';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IsaFlow';
  const ws = wb.addWorksheet(T.sheet);
  const labels: string[] = [T.section, T.accountCode, T.accountName, ...(dims ? [T.dimensionCode, T.dimensionName] : [])];
  ws.addRow([...labels, ...input.months, T.fyTotal]).font = { bold: true };
  for (const r of sheet.rows) {
    const text = [r.accountCode, r.accountName, ...(dims ? [r.dimensionCode ?? '', r.dimensionName ?? ''] : [])].map(neutralise);
    const fy = r.months.reduce<number>((s, v) => s + (v ?? 0), 0);
    ws.addRow([r.section, ...text, ...r.months, Math.round(fy * 100) / 100]);
  }
  for (let c = labels.length + 1; c <= labels.length + input.months.length + 1; c++) ws.getColumn(c).numFmt = T.moneyFormat;
  ws.views = [{ state: 'frozen', xSplit: labels.length, ySplit: 1 }];
  const help = wb.addWorksheet(T.instructions);
  help.addRow(['Your unsaved budget changes']);
  help.addRow([`Version "${input.versionName}", FY${input.fiscalYear}. Only the rows you changed are listed; each row holds all its months.`]);
  help.addRow(['A BLANK cell means "not budgeted". A 0 means "budgeted at zero". Upload this file through Import to review and apply it.']);
  const meta = wb.addWorksheet(T.meta, { state: 'hidden' });
  meta.addRows([
    ['versionId', input.versionId], ['fiscalYear', String(input.fiscalYear)], ['grain', sheet.grain],
    ['updatedAt', input.token], ['templateVersion', String(T.templateVersion)], ['signature', ''],
  ]);
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'budget';

/** Builds and downloads the file(s); resolves with null, or the message to show. */
export async function downloadDirtyCells(input: DirtyExportInput): Promise<string | null> {
  const { sheets, skipped } = dirtySheets(input);
  if (sheets.length === 0) return skipped > 0 ? 'These changes span several dimensions on one row and cannot be written to a template.' : 'There are no unsaved changes to download.';
  let ExcelJS: ExcelModule;
  try {
    ExcelJS = (await import('exceljs')).default as unknown as ExcelModule;
  } catch {
    return 'Could not prepare the spreadsheet. Check your connection and try again.';
  }
  for (const sheet of sheets) {
    const buffer = await workbookFor(ExcelJS, input, sheet);
    const suffix = sheet.grain === 'company' ? '' : `-${sheet.grain}`;
    saveBlob(new Blob([buffer], { type: XLSX_TYPE }), `${safeName(input.versionName)}-FY${input.fiscalYear}-my-changes${suffix}.xlsx`);
  }
  return skipped > 0 ? `${skipped} cells budgeted by several dimensions at once could not be written and were left out.` : null;
}
