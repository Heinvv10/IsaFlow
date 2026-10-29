/**
 * Read an uploaded budget template (P2 spec 9.2) into rows, with no database. The upload goes
 * through `normaliseXlsxSheets` ONCE (the `_meta`, `_base` and `Budget` sheets, one counted inflate,
 * one shared-strings table, a zip bomb refused) and then ONE ExcelJS streaming reader, under
 * BUDGET_IMPORT_LIMITS: sized to the largest template (MAX_IMPORT_ROWS), not to the general
 * importer's 80 MB. Anything the parser itself throws is a 400 with a neutral message
 * (`readNormalised`). Rows are counted by this code (a sheet's own row numbers must increase), columns
 * are capped per row, and the text read has one budget, so one long shared string repeated in every
 * cell cannot multiply. Each limit refuses with a SpreadsheetRefusedError, whose message is for the
 * client.
 *
 * Cells keep their type: a number stays a number (rounded to cents, as the template's `#,##0.00`
 * shows it), text goes through the kit amount parser (`grid/pasteParse.parseCell`), a formula cell
 * counts its cached result, and an empty cell is BLANK: "not budgeted", never 0. Month columns are
 * found by their header TEXT ('YYYY-MM'), never by position. Codes are read as written, with the
 * template's formula-neutralising apostrophe removed; budgetImportResolve matches them exactly
 * first and trimmed only when that is unambiguous (VER-L6).
 */
import ExcelJS from 'exceljs';
import { normaliseXlsxSheets, readerInput, readNormalised, type NormaliseOptions } from '@/lib/xlsxNormalise';
import { looksLikeXlsx, SpreadsheetMalformedError, SpreadsheetTooLargeError, type XlsxLimits } from '@/lib/xlsxToCsv';
import { MAX_MONEY } from '@/lib/money/wholeCents';
import { toCents } from './grid/cents';
import { parseCell, type ParsedCell } from './grid/pasteParse';
import { inputError } from './gridErrors';
import {
  BASE_SHEET, BUDGET_SHEET, COLUMN, MAX_IMPORT_ROWS, META_SHEET, TEMPLATE_GRAINS, TEMPLATE_VERSION, unneutralise,
  type TemplateGrain, type TemplateMeta,
} from './budgetTemplateXlsx';

/** One cell as read: a number, text, empty, or a value that is not an amount (with why). */
export type RawCell = number | string | null | { error: string };

export interface SheetRow {
  /** The sheet's row number (1-based), for messages. */
  row: number;
  /** `cells[0]` is column A. */
  cells: RawCell[];
}

export interface BudgetWorkbook {
  meta: SheetRow[];
  /** The `_base` sheet: the template's rows as downloaded (cents); null when the file has none (Q3b). */
  base: SheetRow[] | null;
  budget: SheetRow[];
}

export interface ImportLayout {
  accountCol: number;
  dimensionCol: number | null;
  /** Each year month and its 0-based column, in the year's order. */
  months: Array<{ month: string; col: number }>;
}

export interface ImportLine {
  row: number;
  accountCode: string;
  dimensionCode: string | null;
  /** One per year month, in the year's order. */
  amounts: Array<{ month: string; cell: ParsedCell }>;
}

/**
 * The largest template (MAX_IMPORT_ROWS rows, each sheet) with room to spare, per row: measured
 * 2026-10-26, a 16 666-row CC1 template filled with 12-digit amounts and 60-character names is
 * 24.9 MB of XML (1.6 KB a row), 9.1 MB of text (0.6 KB) and 1.6 MB of shared strings (0.1 KB);
 * budget-grid-template.int.test.ts imports one at the cap after a re-save (VER-L3).
 * Deliberately below spec 9.2's "50 000 rows, 80 MB" (XLSX_LIMITS): measured 2026-10-26, a filled
 * 50 000-row CC1 template with `_base` is 66.5 MB inflated (Budget 38.5 MB, _base 24.7 MB, shared
 * strings 3.3 MB / 100 000 entries), and the general importer's budget let a 0.2 MB upload of
 * shared-string filler cost 86 s and 4 GB (breaker I5). Styles are capped apart: the template's are
 * a few kB, and 23 MB of <font> cost 720 MB (BRK2-N6). The template refuses past templateRowCap, so
 * export -> import always round-trips (R3, Q1).
 */
const PER_ROW = { inflated: 2560, text: 1024, sharedStrings: 512 };
export const BUDGET_IMPORT_LIMITS: XlsxLimits & Required<Pick<NormaliseOptions, 'maxSharedStringsBytes' | 'maxSharedStrings' | 'maxStylesBytes'>> = {
  maxUncompressedBytes: MAX_IMPORT_ROWS * PER_ROW.inflated,
  maxRows: MAX_IMPORT_ROWS + 1,
  maxColumns: 40,
  maxOutputBytes: MAX_IMPORT_ROWS * PER_ROW.text,
  maxSharedStringsBytes: MAX_IMPORT_ROWS * PER_ROW.sharedStrings,
  maxSharedStrings: 2 * (MAX_IMPORT_ROWS + 1) + 10_000,
  maxStylesBytes: 1024 * 1024,
};

/** Echoed upload text is clipped to this many characters. */
const CLIP = 40;
export const clip = (text: string, max = CLIP): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const refuse = (message: string): never => { throw inputError(message); };

function rawOf(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return { error: `${value ? 'TRUE' : 'FALSE'} is not an amount.` };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { error: 'This cell holds a date no calendar has, not an amount.' } : value.toISOString().slice(0, 10);
  if ('formula' in value || 'sharedFormula' in value) {
    const result = (value as ExcelJS.CellFormulaValue).result;
    if (result === undefined) return { error: 'This formula has no saved result: open the file in Excel, save it, and upload it again.' };
    return rawOf(result as ExcelJS.CellValue);
  }
  if ('richText' in value) return value.richText.map((t) => t.text).join('');
  if ('text' in value) return String(value.text);
  if ('error' in value) return { error: `${clip(String(value.error))} is not an amount.` };
  return { error: 'This cell holds something other than an amount.' };
}

const textLength = (c: RawCell): number => (c === null ? 0 : typeof c === 'object' ? c.error.length : String(c).length);

/** The normalised sheets' non-blank rows, by name, read by one streaming reader. */
async function readSheets(zip: Buffer, names: readonly string[], limits: XlsxLimits): Promise<Map<string, SheetRow[]>> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(readerInput(zip), {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'ignore',
  });
  const out = new Map<string, SheetRow[]>();
  let text = 0;
  let index = 0;
  for await (const sheet of reader) {
    const name = names[index++]!; // the normalised zip holds `names` as sheet1..n, in order
    const rows: SheetRow[] = [];
    let count = 0, lastNumber = 0;
    for await (const row of sheet) {
      if (!Number.isInteger(row.number) || row.number <= lastNumber) {
        throw new SpreadsheetMalformedError('This workbook\'s rows are out of order, which Excel never writes. Open it in Excel, save it again, and upload it.');
      }
      lastNumber = row.number;
      if (++count > limits.maxRows) {
        throw new SpreadsheetTooLargeError(`The ${name} sheet has more than ${limits.maxRows} rows; IsaFlow imports at most ${limits.maxRows} at a time. Split the file and upload each part.`);
      }
      if (row.cellCount > limits.maxColumns) {
        throw new SpreadsheetTooLargeError(`The ${name} sheet has more than ${limits.maxColumns} columns; IsaFlow reads at most ${limits.maxColumns}. Remove the columns you do not need and upload again.`);
      }
      if (!row.hasValues) continue;
      const cells: RawCell[] = [];
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = rawOf(row.getCell(c).value);
        text += textLength(cell) + 1;
        if (text > limits.maxOutputBytes) {
          throw new SpreadsheetTooLargeError(`This workbook holds more than ${Math.round(limits.maxOutputBytes / 1024 / 1024)} MB of text once read. Split the file and upload each part.`);
        }
        cells.push(cell);
      }
      rows.push({ row: row.number, cells });
    }
    out.set(name, rows);
  }
  return out;
}

/** The upload's `_meta`, `_base` (null when absent) and `Budget` sheets. Refuses a file that is not a template workbook. */
export async function readBudgetWorkbook(buf: Buffer, limits = BUDGET_IMPORT_LIMITS): Promise<BudgetWorkbook> {
  if (!looksLikeXlsx(buf)) refuse('This file is not an Excel workbook (.xlsx). Upload the budget template saved as .xlsx.');
  const names = [META_SHEET, BASE_SHEET, BUDGET_SHEET];
  const { zip, sheets } = await normaliseXlsxSheets(buf, names, {
    maxBytes: limits.maxUncompressedBytes, maxSharedStringsBytes: limits.maxSharedStringsBytes, maxSharedStrings: limits.maxSharedStrings,
    maxStylesBytes: limits.maxStylesBytes,
  });
  if (!sheets.includes(META_SHEET)) refuse('This workbook is not an IsaFlow budget template (it has no _meta sheet). Download a fresh template and make your changes in it.');
  if (!sheets.includes(BUDGET_SHEET)) refuse(`This workbook has no "${BUDGET_SHEET}" sheet. Download a fresh template and make your changes in it.`);
  const read = await readNormalised(() => readSheets(zip, sheets, limits));
  return { meta: read.get(META_SHEET) ?? [], base: read.get(BASE_SHEET) ?? null, budget: read.get(BUDGET_SHEET) ?? [] };
}

/** A cell as trimmed text ('' when empty); a number prints as JS does (4000 -> '4000'). */
export function textOf(c: RawCell | undefined): string {
  if (c === null || c === undefined || typeof c === 'object') return '';
  return String(c).trim();
}

/** An account or dimension code cell as written, the template's apostrophe removed ('' when empty). */
export function codeOf(c: RawCell | undefined): string {
  if (c === null || c === undefined || typeof c === 'object') return '';
  return unneutralise(String(c));
}

/** The `_meta` sheet's key/value rows as a TemplateMeta; refuses one that is missing or altered. */
export function parseMeta(rows: readonly SheetRow[]): TemplateMeta {
  const kv = new Map(rows.map((r) => [textOf(r.cells[0]), textOf(r.cells[1])]));
  const altered = () => refuse('This template\'s hidden _meta sheet is missing or was changed. Download a fresh template and make your changes in it.');
  const versionId = kv.get('versionId') ?? '';
  const fiscalYear = Number(kv.get('fiscalYear'));
  const grain = kv.get('grain') as TemplateGrain;
  const templateVersion = Number(kv.get('templateVersion'));
  if (!/^[0-9a-f-]{36}$/i.test(versionId) || !Number.isInteger(fiscalYear) || !TEMPLATE_GRAINS.includes(grain)) return altered();
  if (templateVersion !== TEMPLATE_VERSION) return refuse(`This template is format ${clip(kv.get('templateVersion') ?? '?')}; IsaFlow reads format ${TEMPLATE_VERSION}. Download a fresh template and make your changes in it.`);
  return { versionId: versionId.toLowerCase(), fiscalYear, grain, updatedAt: kv.get('updatedAt') ?? '', templateVersion, signature: kv.get('signature') ?? '' };
}

const MONTH_LIKE = /^\d{4}-\d{1,2}(-\d{1,2})?$/;

/**
 * The header row's columns: the account code, the dimension code (at a dimension grain), and one
 * column per year month found by its header TEXT. The month headers must be the year's months
 * exactly: none missing, none twice, none outside the year. Other columns are ignored.
 */
export function parseLayout(header: SheetRow | undefined, months: readonly string[], grain: TemplateGrain): ImportLayout {
  if (!header) return refuse('The Budget sheet is empty. Download a fresh template and make your changes in it.');
  const texts = header.cells.map(textOf);
  const find = (label: string): number | null => {
    const at = texts.indexOf(label);
    return at < 0 ? null : at;
  };
  const accountCol = find(COLUMN.accountCode) ?? refuse(`The Budget sheet has no "${COLUMN.accountCode}" column. Download a fresh template and make your changes in it.`);
  const dimensionCol = grain === 'company' ? null
    : find(COLUMN.dimensionCode) ?? refuse(`This ${grain.toUpperCase()} template has no "${COLUMN.dimensionCode}" column. Download a fresh template and make your changes in it.`);
  const yearMonths = new Set(months);
  const seen = new Map<string, number>();
  texts.forEach((t, col) => {
    if (!MONTH_LIKE.test(t)) return;
    if (!yearMonths.has(t)) refuse(`Column ${t} is not a month of this financial year (${months[0]} to ${months[months.length - 1]}). Month headers must read YYYY-MM, as downloaded.`);
    if (seen.has(t)) refuse(`The month ${t} is a column heading twice.`);
    seen.set(t, col);
  });
  const missing = months.filter((m) => !seen.has(m));
  if (missing.length > 0) refuse(`The month column${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing. Month headers must read YYYY-MM, as downloaded.`);
  return { accountCol, dimensionCol, months: months.map((month) => ({ month, col: seen.get(month)! })) };
}

/** A month cell: empty is BLANK (not budgeted); a number is rounded to cents; text goes through the kit parser. */
export function amountOf(c: RawCell | undefined): ParsedCell {
  if (c === null || c === undefined) return { kind: 'blank' };
  if (typeof c === 'object') return { kind: 'error', raw: '', reason: c.error };
  if (typeof c === 'number') {
    if (!Number.isFinite(c) || Math.abs(c) > MAX_MONEY) return { kind: 'error', raw: String(c), reason: 'This amount is too large for a budget.' };
    return { kind: 'value', cents: toCents(c) };
  }
  return parseCell(c);
}

/** The data rows under the header (rows with no code and no amounts are skipped). */
export function parseLines(rows: readonly SheetRow[], layout: ImportLayout): ImportLine[] {
  const out: ImportLine[] = [];
  for (const r of rows) {
    const amounts = layout.months.map(({ month, col }) => ({ month, cell: amountOf(r.cells[col]) }));
    const accountCode = codeOf(r.cells[layout.accountCol]);
    if (accountCode.trim() === '' && amounts.every((a) => a.cell.kind === 'blank')) continue;
    const dimensionCode = layout.dimensionCol === null ? null : codeOf(r.cells[layout.dimensionCol]);
    out.push({ row: r.row, accountCode, dimensionCode, amounts });
  }
  return out;
}
