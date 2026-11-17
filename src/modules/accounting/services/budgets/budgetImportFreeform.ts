/**
 * A free-form budget sheet (MCP budget tools PR 2, review rounds 2 and 3): an .xlsx that is not an IsaFlow template
 * read from its first VISIBLE sheet (`budgetImportFreeformRead`) as an account-code column plus one column for every
 * month of the version's year, into the Excel import's own lines, so the import's resolver and diff take it from
 * there (`budgetImportDiff`, base `'current'`: an explicit overwrite of the version as it is). The app's import route
 * does not call this; it still reads templates only (`readBudgetWorkbook`).
 *
 * Layout: the header row is the first of rows 1 to 20 OF THE SHEET with an account-code column ("Account code",
 * "Code" or "Account", any case; the first of those it has wins, a lower one in the same row is a name column).
 * Month columns are headed YYYY-MM, by a date (any day of the month), or by a month name (Mar, March, Sept), with a
 * year (Mar 2026, Mar-26) or without one when exactly one year month has that name. At a cc1 / cc2 / bu grain one
 * dimension column ("Dimension code", "Dimension", or the grain's own: "CC1", "Cost centre", ...); a second one, or one
 * on a company import, is refused (decision 14: one dimension per amount). Account name, Name, Description, Section,
 * Total, FY total, PY actual and Notes columns are ignored. Every other header, a month missing or twice, a month
 * outside the year, a value under no header, a range merged across month columns, and the IsaFlow template's own
 * header (a template stripped of its hidden sheets, whose blanks mean "clear") are refused whole with their sheet,
 * row and column.
 *
 * Rows: one with no code, a total row (Total, Totals, Subtotal, Grand total), or one whose code is no account and
 * which has no amounts (a heading) is SKIPPED and listed; a code that is no account with amounts reaches the
 * resolver, which refuses it. A numeric code that lost a leading zero (400 for 0400) is refused, never guessed.
 *
 * Cells: blank KEEPS the version's amount (a free-form sheet need not list every month it does not change); the text
 * "clear" clears the month; a number with more than two decimals, a TRUE / FALSE or error result, and a formula
 * formatted as a date are refused per cell (the template import rounds numbers to cents; a free-form sheet is not
 * rounded); anything else is an amount as the template import reads one (`amountOf`).
 */
import { inputError } from './gridErrors';
import type { GridReadModel } from './gridReadTypes';
import { codeIndex } from './codeIndex';
import { GRAIN_LABEL, type TemplateGrain } from './budgetTemplateXlsx';
import { amountOf, clip, codeOf, textOf, type ImportLine, type RawCell, type SheetRow } from './budgetImportParse';
import type { ImportIssue } from './budgetImportResolve';
import type { FreeformSheet } from './budgetImportFreeformRead';

export type { FreeformSheet } from './budgetImportFreeformRead';
/** The word a free-form cell holds to clear its month (a blank cell keeps it). */
export const CLEAR_WORD = 'clear';
const HEADER_ROWS = 20;
const TOTAL_WORDS = new Set(['total', 'totals', 'subtotal', 'sub total', 'sub-total', 'grand total']);
const TEMPLATE_HEADER = ['section', 'account code', 'account name'];
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

function headerRow(sheet: FreeformSheet, where: string): { header: SheetRow; codeCol: number } {
  for (const r of sheet.rows) {
    if (r.row > HEADER_ROWS) break; // rows 1 to 20 of the sheet, blank rows counted
    const texts = r.cells.map(norm);
    const rank = CODE_HEADERS.findIndex((h) => texts.includes(h));
    if (rank < 0) continue;
    const cols = texts.flatMap((t, i) => (t === CODE_HEADERS[rank] ? [i] : []));
    if (cols.length > 1) throw inputError(`${where}, row ${r.row}, columns ${cols.map(letter).join(' and ')}: both are an account code column; keep one.`);
    if (TEMPLATE_HEADER.every((h) => texts.includes(h)) && (texts.includes('fy total') || texts.includes('py actual'))) {
      throw inputError(`${where}, row ${r.row}: this is an IsaFlow budget template without its hidden _meta and _base sheets; download a fresh one (get_budget_template format xlsx) and make your changes in it, `
        + 'since without them its blank cells would keep amounts instead of clearing them.');
    }
    return { header: r, codeCol: cols[0]! };
  }
  throw inputError(`${where}: no header row with an account code column ("Account code", "Code" or "Account") in rows 1 to ${HEADER_ROWS} of the sheet. Head the code column so, and one column per month.`);
}

export interface FreeformLines {
  lines: ImportLine[];
  /** Rows left out that are no account (no code, a total, a heading with no amounts), by sheet row. */
  skipped: Array<{ row: number; reason: string }>;
  /** Rows refused before the resolver (a numeric code that lost its leading zero), with the code as read. */
  errors: Array<ImportIssue & { account: string }>;
}

const NOT_CENTS = 'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)';
const TYPED: Record<'boolean' | 'error', string> = {
  boolean: 'This cell is a TRUE / FALSE result, not an amount.', error: 'This formula\'s result is an error, not an amount.',
};

/** The free-form sheet as import lines (`row` = the sheet row). Throws a BUDGET_VERSION_INPUT naming the sheet, row and column. */
export function freeformLines(model: GridReadModel, grain: TemplateGrain, sheet: FreeformSheet): FreeformLines {
  const months = model.year.monthKeys;
  const fy = model.year.fiscalYear;
  const where = `Sheet "${clip(sheet.name)}"`;
  const { header, codeCol } = headerRow(sheet, where);
  const at = (col: number) => `${where}, row ${header.row}, column ${letter(col)}`;
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
  if (missing.length > 0) throw inputError(`${where}, row ${header.row}: no column for ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''} (every month of FY${fy} needs one; leave a cell blank to keep its amount).`);
  if (grain !== 'company' && dimCol === null) {
    throw inputError(`${where}, row ${header.row}: a ${GRAIN_LABEL[grain]} import needs a dimension column ("Dimension code", ${DIMENSION_SHOWN[grain]}).`);
  }
  const monthCols = new Set(monthCol.values());
  const merged = sheet.merges.find((m) => (m.right > m.left || m.bottom > m.top) && [...monthCols].some((c) => c >= m.left && c <= m.right));
  if (merged) throw inputError(`${where}, cells ${clip(merged.ref)}: merged across month columns (only the first month would be read); unmerge them and give each month its amount.`);

  const find = codeIndex(model.accounts);
  const out: FreeformLines = { lines: [], skipped: [], errors: [] };
  for (const r of sheet.rows) {
    if (r.row <= header.row) continue;
    const stray = r.cells.findIndex((c, col) => c !== null && c !== undefined && !known.has(col));
    if (stray >= 0) throw inputError(`${where}, row ${r.row}, column ${letter(stray)}: a value under no header. Head the column or remove the value.`);
    const amounts = months.map((month) => {
      const col = monthCol.get(month)!;
      const c = r.cells[col];
      const typed = sheet.typed.get(`${r.row}:${col}`);
      if (typed) return { month, cell: { kind: 'error' as const, raw: '', reason: TYPED[typed] } };
      if (c === null || c === undefined || (typeof c === 'string' && c.trim() === '')) return { month, cell: { kind: 'blank' as const }, keep: true as const };
      if (typeof c === 'string' && c.trim().toLowerCase() === CLEAR_WORD) return { month, cell: { kind: 'blank' as const } };
      if (typeof c === 'number' && Math.abs(c * 100 - Math.round(c * 100)) >= 1e-6) return { month, cell: { kind: 'error' as const, raw: String(c), reason: NOT_CENTS } };
      return { month, cell: amountOf(c) };
    });
    const raw = r.cells[codeCol];
    const accountCode = codeOf(raw);
    const code = accountCode.trim();
    const noAmounts = amounts.every((a) => a.keep);
    if (code === '') { out.skipped.push({ row: r.row, reason: 'no account code' }); continue; }
    if (typeof raw === 'number') {
      const padded = model.accounts.filter((a) => a.code.trim() !== code && /^0+\d/.test(a.code.trim()) && a.code.trim().replace(/^0+/, '') === code);
      if (padded.length > 0) {
        const message = find(code)
          ? `Account code ${code} is a number and could be ${code} or ${padded[0]!.code.trim()} (a lost leading zero). Format the code column as text and type the code.`
          : `Account code ${code} is a number: it lost its leading zero (${padded[0]!.code.trim()}?). Format the code column as text and type the code.`;
        out.errors.push({ row: r.row, column: 'Account code', message, account: code });
        continue;
      }
    }
    if (find(accountCode) === undefined) {
      if (TOTAL_WORDS.has(code.toLowerCase().replace(/\s+/g, ' '))) { out.skipped.push({ row: r.row, reason: 'a total row' }); continue; }
      if (noAmounts) { out.skipped.push({ row: r.row, reason: 'not an account, and no amounts (a heading?)' }); continue; }
    }
    out.lines.push({ row: r.row, accountCode, dimensionCode: dimCol === null ? null : codeOf(r.cells[dimCol]), amounts });
  }
  return out;
}
