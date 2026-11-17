/**
 * Which kind of budget workbook an MCP upload is, and a free-form sheet's contents (MCP budget tools PR 2, review
 * rounds 2 and 3). An upload with a sheet named exactly `_meta` or `_base` is an IsaFlow template, read by
 * `readBudgetWorkbook` exactly as the app's import preview reads it. One with a sheet whose name is `_meta` or
 * `_base` but for case or spaces (`_Meta`, `_meta `) is refused: a renamed hidden sheet would turn a template into a
 * free-form sheet, whose blanks keep instead of clearing. Otherwise the FIRST VISIBLE sheet is the free-form sheet
 * (a hidden or very hidden one is never read: a stale draft is often hidden first), with what the streaming reader
 * loses read from the sheet's XML itself: merged ranges, and cells typed boolean or error (the reader gives TRUE as
 * 1). A formula whose result is formatted as a date reads as a refusal, as a plain date cell does. The app's
 * import route does not call this.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normaliseXlsxSheets, readNormalised, workbookSheets } from '@/lib/xlsxNormalise';
import { looksLikeXlsx } from '@/lib/xlsxToCsv';
import { inputError } from './gridErrors';
import { BASE_SHEET, META_SHEET } from './budgetTemplateXlsx';
import { BUDGET_IMPORT_LIMITS, clip, readBudgetWorkbook, readSheets, type BudgetWorkbook, type RawCell, type SheetRow } from './budgetImportParse';

/** A merged range: rows 1-based, columns 0-based, inclusive. */
export interface SheetMerge { ref: string; top: number; left: number; bottom: number; right: number }

export interface FreeformSheet {
  name: string;
  rows: SheetRow[];
  merges: SheetMerge[];
  /** Cells the XML types boolean or error, by `${sheet row}:${0-based column}`. */
  typed: Map<string, 'boolean' | 'error'>;
}

export type ImportWorkbook = { kind: 'template'; wb: BudgetWorkbook } | { kind: 'freeform'; sheet: FreeformSheet };

const CELL_TAG = /<(?:[\w.-]{1,64}:)?c\b[^>]{0,1024}>/g;
const MERGE_TAG = /<(?:[\w.-]{1,64}:)?mergeCell\b[^>]{0,512}>/g;
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];

/** "C12" → { row: 12, col: 2 }; null for anything else. */
export function cellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col: col - 1 };
}

/** A number format that shows a date or a time (quoted text, [colour] / [locale] sections and escapes removed first). */
export function isDateFormat(format: string | undefined): boolean {
  if (!format || /^general$/i.test(format)) return false;
  const bare = format.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/[_*]./g, '');
  return /[dmyhs]/i.test(bare);
}

/** The free-form reader's own reading of a cell: a formula formatted as a date is not an amount. */
const inspect = (cell: ExcelJS.Cell): RawCell | undefined =>
  cell.type === ExcelJS.ValueType.Formula && isDateFormat(cell.numFmt) ? { error: 'This formula\'s result is formatted as a date, not an amount.' } : undefined;

function scanXml(xml: string): Pick<FreeformSheet, 'merges' | 'typed'> {
  const typed = new Map<string, 'boolean' | 'error'>();
  for (const m of xml.matchAll(CELL_TAG)) {
    const t = attr(m[0], 't');
    if (t !== 'b' && t !== 'e') continue;
    const at = cellRef(attr(m[0], 'r') ?? '');
    if (at) typed.set(`${at.row}:${at.col}`, t === 'b' ? 'boolean' : 'error');
  }
  const merges: SheetMerge[] = [];
  for (const m of xml.matchAll(MERGE_TAG)) {
    const ref = attr(m[0], 'ref') ?? '';
    const [a, b] = ref.split(':').map(cellRef);
    if (a && b) merges.push({ ref, top: Math.min(a.row, b.row), left: Math.min(a.col, b.col), bottom: Math.max(a.row, b.row), right: Math.max(a.col, b.col) });
  }
  return { merges, typed };
}

/** The upload as an IsaFlow template or as a free-form sheet (its first visible sheet), under the template import's limits. */
export async function readImportWorkbook(buf: Buffer, limits = BUDGET_IMPORT_LIMITS): Promise<ImportWorkbook> {
  if (!looksLikeXlsx(buf)) throw inputError('This file is not an Excel workbook (.xlsx). Send the budget template, or a sheet of account codes and months, saved as .xlsx.');
  const sheets = await workbookSheets(buf, limits.maxUncompressedBytes);
  const squash = (name: string) => name.toLowerCase().replace(/\s+/g, '');
  const near = sheets.find((s) => [META_SHEET, BASE_SHEET].includes(squash(s.name)) && s.name !== META_SHEET && s.name !== BASE_SHEET);
  if (near) {
    throw inputError(`This workbook has a sheet named "${clip(near.name)}" that is not IsaFlow's ${squash(near.name)} sheet exactly (it was renamed), so IsaFlow cannot tell whether this is a template. `
      + 'Download a fresh template (get_budget_template format xlsx) and make your changes in it, or, for a free-form sheet, delete that sheet.');
  }
  if (sheets.some((s) => s.name === META_SHEET || s.name === BASE_SHEET)) return { kind: 'template', wb: await readBudgetWorkbook(buf, limits) };
  const visible = sheets.find((s) => s.state === 'visible');
  if (!visible) throw inputError('This workbook has no visible sheet to read.');
  const { zip, sheets: found } = await normaliseXlsxSheets(buf, [visible.name], {
    maxBytes: limits.maxUncompressedBytes, maxSharedStringsBytes: limits.maxSharedStringsBytes, maxSharedStrings: limits.maxSharedStrings, maxStylesBytes: limits.maxStylesBytes,
  });
  if (found.length === 0) throw inputError(`Sheet "${clip(visible.name)}" is not a plain worksheet, so it cannot be read as a budget sheet.`);
  const rows = (await readNormalised(() => readSheets(zip, [visible.name], limits, inspect))).get(visible.name) ?? [];
  const xml = await (await JSZip.loadAsync(zip)).file('xl/worksheets/sheet1.xml')!.async('string');
  return { kind: 'freeform', sheet: { name: visible.name, rows, ...scanXml(xml) } };
}
