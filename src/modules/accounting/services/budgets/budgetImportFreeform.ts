/**
 * A free-form budget sheet (MCP budget tools PR 2, review round 2): an .xlsx that is not an IsaFlow template
 * (neither `_meta` nor `_base`) read from its FIRST sheet as an account-code column plus one column for every month
 * of the version's year, into the Excel import's own lines, so the import's resolver and diff take it from there
 * (`budgetImportDiff`, base `'current'`: an explicit overwrite of the version as it is). The app's import route does
 * not call this; it still reads templates only (`readBudgetWorkbook`).
 *
 * Layout: the header row is the first of the sheet's first 20 rows with an account-code column ("Account code",
 * "Code" or "Account", any case; the first of those it has wins, a lower one in the same row is a name column).
 * Month columns are headed YYYY-MM, by a date (any day of the month), or by a month name (Mar, March, Sept), with a
 * year (Mar 2026, Mar-26) or without one when exactly one year month has that name. At a cc1 / cc2 / bu grain one
 * dimension column ("Dimension code", "Dimension", or the grain's own: "CC1", "Cost centre", ...); a second one, or one
 * on a company import, is refused (decision 14: one dimension per amount). Account name, Name, Description, Section,
 * Total, FY total, PY actual and Notes columns are ignored. Every other header, a month missing or twice, a month
 * outside the year, and a value under no header is refused whole with its sheet, row and column.
 *
 * Cells: blank KEEPS the version's amount (a free-form sheet need not list every month it does not change); the text
 * "clear" clears the month; anything else is an amount as the template import reads one (`amountOf`).
 */
import { normaliseXlsx, normaliseXlsxSheets, readNormalised } from '@/lib/xlsxNormalise';
import { looksLikeXlsx } from '@/lib/xlsxToCsv';
import { inputError } from './gridErrors';
import type { GridReadModel } from './gridReadTypes';
import { BASE_SHEET, GRAIN_LABEL, META_SHEET, type TemplateGrain } from './budgetTemplateXlsx';
import {
  amountOf, BUDGET_IMPORT_LIMITS, clip, codeOf, readBudgetWorkbook, readSheets, textOf, type BudgetWorkbook, type ImportLine, type RawCell, type SheetRow,
} from './budgetImportParse';

export type ImportWorkbook = { kind: 'template'; wb: BudgetWorkbook } | { kind: 'freeform'; rows: SheetRow[] };

/** The word a free-form cell holds to clear its month (a blank cell keeps it). */
export const CLEAR_WORD = 'clear';
const HEADER_ROWS = 20;
const CODE_HEADERS = ['account code', 'code', 'account'];
const IGNORED = new Set(['account name', 'name', 'description', 'section', 'total', 'fy total', 'py actual', 'notes', 'note', 'dimension name']);
const ANY_DIMENSION = ['dimension code', 'dimension'];
const DIMENSIONS: Record<Exclude<TemplateGrain, 'company'>, string[]> = {
  cc1: ['cc1', 'cc1 code', 'cost centre', 'cost center', 'cost centre 1', 'cost center 1'],
  cc2: ['cc2', 'cc2 code', 'cost centre 2', 'cost center 2'],
  bu: ['bu', 'bu code', 'business unit'],
};
const DIMENSION_SHOWN: Record<Exclude<TemplateGrain, 'company'>, string> = {
  cc1: '"CC1", "Cost centre" or "Cost center"', cc2: '"CC2" or "Cost centre 2"', bu: '"BU" or "Business unit"',
};
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * The upload as an IsaFlow template (it has a `_meta` or `_base` sheet: read exactly as the import preview reads it)
 * or as a free-form sheet (neither: its first sheet's rows), under the template import's limits.
 */
export async function readImportWorkbook(buf: Buffer, limits = BUDGET_IMPORT_LIMITS): Promise<ImportWorkbook> {
  if (!looksLikeXlsx(buf)) throw inputError('This file is not an Excel workbook (.xlsx). Send the budget template, or a sheet of account codes and months, saved as .xlsx.');
  const caps = { maxSharedStringsBytes: limits.maxSharedStringsBytes, maxSharedStrings: limits.maxSharedStrings, maxStylesBytes: limits.maxStylesBytes };
  const { sheets } = await normaliseXlsxSheets(buf, [META_SHEET, BASE_SHEET], { maxBytes: limits.maxUncompressedBytes, ...caps });
  if (sheets.length > 0) return { kind: 'template', wb: await readBudgetWorkbook(buf, limits) };
  const zip = await normaliseXlsx(buf, limits.maxUncompressedBytes, caps);
  if (!zip) throw inputError('This workbook has no sheet to read.');
  const read = await readNormalised(() => readSheets(zip, ['first'], limits));
  return { kind: 'freeform', rows: read.get('first') ?? [] };
}

const letter = (col: number): string => {
  let n = col + 1, out = '';
  while (n > 0) { out = String.fromCharCode(65 + ((n - 1) % 26)) + out; n = Math.floor((n - 1) / 26); }
  return out;
};
const norm = (c: RawCell | undefined) => textOf(c).toLowerCase().replace(/\s+/g, ' ');

type MonthOf = { month: string } | { error: string } | null;

/** A header's year month: YYYY-MM, a date, or a month name (with a year, or one that names a single year month). */
export function monthOfHeader(raw: RawCell | undefined, months: readonly string[], fiscalYear: number): MonthOf {
  const text = textOf(raw);
  const outside = (): MonthOf => ({ error: `"${clip(text)}" is not a month of FY${fiscalYear} (${months[0]} to ${months[months.length - 1]})` });
  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?(?:T[\d:.]+Z?)?$/.exec(text);
  if (iso) {
    const m = Number(iso[2]);
    if (m < 1 || m > 12) return null;
    const key = `${iso[1]}-${String(m).padStart(2, '0')}`;
    return months.includes(key) ? { month: key } : outside();
  }
  const named = /^([A-Za-z]+)\.?(?:[\s\-/'’,]*(\d{4}|\d{2}))?$/.exec(text);
  if (!named) return null;
  const word = named[1]!.toLowerCase();
  const m = MONTH_NAMES.findIndex((full) => full === word || (word.length >= 3 && full.startsWith(word))) + 1;
  if (m === 0) return null;
  const mm = String(m).padStart(2, '0');
  if (named[2] !== undefined) {
    const key = `${named[2].length === 2 ? `20${named[2]}` : named[2]}-${mm}`;
    return months.includes(key) ? { month: key } : outside();
  }
  const hits = months.filter((k) => k.endsWith(`-${mm}`));
  if (hits.length === 1) return { month: hits[0]! };
  if (hits.length === 0) return outside();
  return { error: `"${clip(text)}" is ${hits.join(' or ')} in FY${fiscalYear}; write the year (${clip(text)} ${hits[0]!.slice(0, 4)}) or YYYY-MM` };
}

function headerRow(rows: readonly SheetRow[]): { header: SheetRow; codeCol: number } {
  for (const r of rows.slice(0, HEADER_ROWS)) {
    const texts = r.cells.map(norm);
    const rank = CODE_HEADERS.findIndex((h) => texts.includes(h));
    if (rank < 0) continue;
    const cols = texts.flatMap((t, i) => (t === CODE_HEADERS[rank] ? [i] : []));
    if (cols.length > 1) throw inputError(`First sheet, row ${r.row}, columns ${cols.map(letter).join(' and ')}: both are an account code column; keep one.`);
    return { header: r, codeCol: cols[0]! };
  }
  throw inputError(`First sheet: no header row with an account code column ("Account code", "Code" or "Account") in its first ${HEADER_ROWS} rows. Head the code column so, and one column per month.`);
}

/** The free-form sheet's rows as import lines (`row` = the sheet row). Throws a BUDGET_VERSION_INPUT naming the sheet, row and column. */
export function freeformLines(model: GridReadModel, grain: TemplateGrain, rows: readonly SheetRow[]): ImportLine[] {
  const months = model.year.monthKeys;
  const fy = model.year.fiscalYear;
  const { header, codeCol } = headerRow(rows);
  const at = (col: number) => `First sheet, row ${header.row}, column ${letter(col)}`;
  const monthCol = new Map<string, number>();
  const known = new Set<number>([codeCol]);
  let dimCol: number | null = null;
  header.cells.forEach((cell, col) => {
    const key = norm(cell);
    if (col === codeCol || key === '') return;
    known.add(col);
    if (CODE_HEADERS.includes(key) || IGNORED.has(key)) return;
    const kind = ANY_DIMENSION.includes(key) ? 'any' : (Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>).find((k) => DIMENSIONS[k].includes(key)) ?? null;
    if (kind !== null) {
      if (grain === 'company') throw inputError(`${at(col)}: "${clip(textOf(cell))}" names a dimension; a company-level import has none (send grain cc1, cc2 or bu).`);
      if (dimCol !== null) throw inputError(`${at(col)}: "${clip(textOf(cell))}" is a second dimension column; a budget amount carries at most one dimension (decision 14).`);
      if (kind !== 'any' && kind !== grain) throw inputError(`${at(col)}: "${clip(textOf(cell))}" is a ${GRAIN_LABEL[kind]} column; this is a ${GRAIN_LABEL[grain]} import (send grain ${kind}).`);
      dimCol = col;
      return;
    }
    const month = monthOfHeader(cell, months, fy);
    if (month === null) {
      throw inputError(`${at(col)}: "${clip(textOf(cell))}" is not an account code, dimension or month column of FY${fy} (${months[0]} to ${months[months.length - 1]}). `
        + 'Remove it; IsaFlow ignores only Account name, Name, Description, Section, Total, FY total, PY actual and Notes columns.');
    }
    if ('error' in month) throw inputError(`${at(col)}: ${month.error}.`);
    const twice = monthCol.get(month.month);
    if (twice !== undefined) throw inputError(`${at(col)}: ${month.month} is also column ${letter(twice)}.`);
    monthCol.set(month.month, col);
  });
  const missing = months.filter((m) => !monthCol.has(m));
  if (missing.length > 0) throw inputError(`First sheet, row ${header.row}: no column for ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''} (every month of FY${fy} needs one; leave a cell blank to keep its amount).`);
  if (grain !== 'company' && dimCol === null) {
    throw inputError(`First sheet, row ${header.row}: a ${GRAIN_LABEL[grain]} import needs a dimension column ("Dimension code", ${DIMENSION_SHOWN[grain]}).`);
  }
  const lines: ImportLine[] = [];
  for (const r of rows) {
    if (r.row <= header.row) continue;
    const stray = r.cells.findIndex((c, col) => c !== null && c !== undefined && !known.has(col));
    if (stray >= 0) throw inputError(`First sheet, row ${r.row}, column ${letter(stray)}: a value under no header. Head the column or remove the value.`);
    const amounts = months.map((month) => {
      const c = r.cells[monthCol.get(month)!];
      if (c === null || c === undefined || (typeof c === 'string' && c.trim() === '')) return { month, cell: { kind: 'blank' as const }, keep: true as const };
      if (typeof c === 'string' && c.trim().toLowerCase() === CLEAR_WORD) return { month, cell: { kind: 'blank' as const } };
      return { month, cell: amountOf(c) };
    });
    const accountCode = codeOf(r.cells[codeCol]);
    if (accountCode.trim() === '' && amounts.every((a) => a.keep)) continue;
    lines.push({ row: r.row, accountCode, dimensionCode: dimCol === null ? null : codeOf(r.cells[dimCol]), amounts });
  }
  return lines;
}
