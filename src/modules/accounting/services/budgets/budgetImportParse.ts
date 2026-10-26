/**
 * Read an uploaded budget template (P2 spec 9.2) into rows, with no database. The upload goes
 * through `normaliseXlsx` (one counted inflate per sheet, a zip bomb refused) and then ExcelJS's
 * STREAMING reader, as `src/lib/xlsxToCsv.ts` does, under the same `XLSX_LIMITS`: rows counted by
 * this code (a sheet's own row numbers must increase), columns capped per row, and a budget on the
 * text read so one long shared string repeated in every cell cannot multiply. Each limit refuses
 * with a SpreadsheetRefusedError, whose message is for the client.
 *
 * Cells keep their type: a number stays a number (rounded to cents, as the template's `#,##0.00`
 * shows it), text goes through the kit amount parser (`grid/pasteParse.parseCell`), a formula cell
 * counts its cached result, and an empty cell is BLANK: "not budgeted", never 0. Month columns are
 * found by their header TEXT ('YYYY-MM'), never by position.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { normaliseXlsx } from '@/lib/xlsxNormalise';
import { looksLikeXlsx, SpreadsheetMalformedError, SpreadsheetTooLargeError, XLSX_LIMITS, type XlsxLimits } from '@/lib/xlsxToCsv';
import { MAX_MONEY } from '@/lib/money/wholeCents';
import { BudgetVersionError } from './budgetVersionTypes';
import { toCents } from './grid/cents';
import { parseCell, type ParsedCell } from './grid/pasteParse';
import { BUDGET_SHEET, COLUMN, META_SHEET, TEMPLATE_GRAINS, TEMPLATE_VERSION, type TemplateGrain, type TemplateMeta } from './budgetTemplateXlsx';

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

const refuse = (message: string): never => { throw new BudgetVersionError('BUDGET_VERSION_INPUT', message); };

function rawOf(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return { error: `${value ? 'TRUE' : 'FALSE'} is not an amount.` };
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if ('formula' in value || 'sharedFormula' in value) {
    const result = (value as ExcelJS.CellFormulaValue).result;
    if (result === undefined) return { error: 'This formula has no saved result: open the file in Excel, save it, and upload it again.' };
    return rawOf(result as ExcelJS.CellValue);
  }
  if ('richText' in value) return value.richText.map((t) => t.text).join('');
  if ('text' in value) return String(value.text);
  if ('error' in value) return { error: `${String(value.error)} is not an amount.` };
  return { error: 'This cell holds something other than an amount.' };
}

const textLength = (c: RawCell): number => (c === null ? 0 : typeof c === 'object' ? c.error.length : String(c).length);

/** One named sheet's non-blank rows, or null when the workbook has no sheet of that name. */
async function readSheet(buf: Buffer, name: string, limits: XlsxLimits): Promise<SheetRow[] | null> {
  const normalised = await normaliseXlsx(buf, limits.maxUncompressedBytes, name);
  if (!normalised) return null;
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([normalised]), {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'ignore',
  });
  const rows: SheetRow[] = [];
  let count = 0, lastNumber = 0, text = 0;
  for await (const sheet of reader) {
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
          throw new SpreadsheetTooLargeError(`The ${name} sheet holds more than ${Math.round(limits.maxOutputBytes / 1024 / 1024)} MB of text once read. Split the file and upload each part.`);
        }
        cells.push(cell);
      }
      rows.push({ row: row.number, cells });
    }
    break; // the normalised zip holds the one sheet only
  }
  return rows;
}

/** The upload's `_meta` and `Budget` sheets. Refuses a file that is not a template workbook. */
export async function readBudgetWorkbook(buf: Buffer, limits: XlsxLimits = XLSX_LIMITS): Promise<BudgetWorkbook> {
  if (!looksLikeXlsx(buf)) refuse('This file is not an Excel workbook (.xlsx). Upload the budget template saved as .xlsx.');
  const meta = await readSheet(buf, META_SHEET, limits);
  if (!meta) return refuse('This workbook is not an IsaFlow budget template (it has no _meta sheet). Download the template and fill that in.');
  const budget = await readSheet(buf, BUDGET_SHEET, limits);
  if (!budget) return refuse(`This workbook has no "${BUDGET_SHEET}" sheet. Download the template and fill that in.`);
  return { meta, budget };
}

/** A cell as trimmed text ('' when empty); a number prints as JS does (4000 -> '4000'). */
export function textOf(c: RawCell | undefined): string {
  if (c === null || c === undefined || typeof c === 'object') return '';
  return String(c).trim();
}

/** The `_meta` sheet's key/value rows as a TemplateMeta; refuses one that is missing or altered. */
export function parseMeta(rows: readonly SheetRow[]): TemplateMeta {
  const kv = new Map(rows.map((r) => [textOf(r.cells[0]), textOf(r.cells[1])]));
  const altered = () => refuse('This template\'s hidden _meta sheet is missing or was changed. Download the template again.');
  const versionId = kv.get('versionId') ?? '';
  const fiscalYear = Number(kv.get('fiscalYear'));
  const grain = kv.get('grain') as TemplateGrain;
  const templateVersion = Number(kv.get('templateVersion'));
  if (!/^[0-9a-f-]{36}$/i.test(versionId) || !Number.isInteger(fiscalYear) || !TEMPLATE_GRAINS.includes(grain)) return altered();
  if (templateVersion !== TEMPLATE_VERSION) return refuse(`This template is format ${kv.get('templateVersion') ?? '?'}; IsaFlow reads format ${TEMPLATE_VERSION}. Download the template again.`);
  return { versionId: versionId.toLowerCase(), fiscalYear, grain, updatedAt: kv.get('updatedAt') ?? '', templateVersion };
}

const MONTH_LIKE = /^\d{4}-\d{1,2}(-\d{1,2})?$/;

/**
 * The header row's columns: the account code, the dimension code (at a dimension grain), and one
 * column per year month found by its header TEXT. The month headers must be the year's months
 * exactly: none missing, none twice, none outside the year. Other columns are ignored.
 */
export function parseLayout(header: SheetRow | undefined, months: readonly string[], grain: TemplateGrain): ImportLayout {
  if (!header) return refuse('The Budget sheet is empty. Download the template and fill that in.');
  const texts = header.cells.map(textOf);
  const find = (label: string): number | null => {
    const at = texts.indexOf(label);
    return at < 0 ? null : at;
  };
  const accountCol = find(COLUMN.accountCode) ?? refuse(`The Budget sheet has no "${COLUMN.accountCode}" column. Download the template again.`);
  const dimensionCol = grain === 'company' ? null
    : find(COLUMN.dimensionCode) ?? refuse(`This ${grain.toUpperCase()} template has no "${COLUMN.dimensionCode}" column. Download the template again.`);
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
    const accountCode = textOf(r.cells[layout.accountCol]);
    if (accountCode === '' && amounts.every((a) => a.cell.kind === 'blank')) continue;
    const dimensionCode = layout.dimensionCol === null ? null : textOf(r.cells[layout.dimensionCol]);
    out.push({ row: r.row, accountCode, dimensionCode, amounts });
  }
  return out;
}
