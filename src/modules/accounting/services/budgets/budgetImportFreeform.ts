/**
 * A free-form budget sheet (MCP budget tools PR 2, review rounds 2 to 4): an .xlsx that is not an IsaFlow template,
 * its first visible sheet PARSED cell by cell (`budgetImportFreeformRead`), read as an account-code column plus one column for every
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
 * outside the year, a value under no header, and the IsaFlow template's own header (a template stripped of its
 * hidden sheets, whose blanks mean "clear") are refused whole with their sheet, row and column.
 *
 * EVERY MONEY CELL IS ACCOUNTED FOR (round 4): a row is skipped (and listed) only when its month cells are all empty,
 * or when it is a total row (Total, Totals, Subtotal, Grand total) that is no account; a row with any month cell
 * filled and a blank, error or unreadable code is refused, and a code that is no account with amounts reaches the
 * resolver, which refuses it. A numeric code that lost a leading zero (400 for 0400) is refused, never guessed.
 *
 * Cells: blank KEEPS the version's amount (a free-form sheet need not list every month it does not change); the text
 * "clear" clears the month; text is an amount as the template import reads text (`amountOf`); a number is one only
 * when its number format is General or a plain number / currency / accounting format (`isPlainNumberFormat`) and it
 * is a whole number of cents (a free-form sheet is not rounded; the template import rounds); a TRUE / FALSE, error,
 * date or result-less formula cell is refused per cell.
 */
import { inputError } from './gridErrors';
import type { GridReadModel } from './gridReadTypes';
import { codeIndex } from './codeIndex';
import { GRAIN_LABEL, type TemplateGrain } from './budgetTemplateXlsx';
import { amountOf, clip, codeOf, type ImportLine } from './budgetImportParse';
import type { ImportIssue } from './budgetImportResolve';
import type { FreeformSheet } from './budgetImportFreeformRead';
import { serialDate } from './budgetFreeformXml';
import { columnLetter as letter, type FreeCell, type FreeRow } from './budgetFreeformSheet';

export type { FreeformSheet } from './budgetImportFreeformRead';
export type { FreeCell, FreeRow } from './budgetFreeformSheet';
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

/** A header cell as text: a number formatted as a date reads as that date (YYYY-MM-DD). */
const headerText = (c: FreeCell | null | undefined, date1904: boolean): string => {
  if (!c || c.kind === 'bad') return '';
  if (c.kind === 'text') return c.text.trim();
  return c.plain ? String(c.value) : serialDate(c.value, date1904) ?? String(c.value);
};
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ');

type MonthOf = { month: string } | { error: string } | null;

/** A header's year month: YYYY-MM, a date, or a month name (with a year, or one that names a single year month). */
export function monthOfHeader(text: string, months: readonly string[], fiscalYear: number): MonthOf {
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

function headerRow(sheet: FreeformSheet, where: string): { header: FreeRow; texts: string[]; codeCol: number } {
  for (const r of sheet.rows) {
    if (r.row > HEADER_ROWS) break; // rows 1 to 20 of the sheet, blank rows counted
    const shown = r.cells.map((c) => headerText(c, sheet.date1904 === true));
    const texts = shown.map(norm);
    const rank = CODE_HEADERS.findIndex((h) => texts.includes(h));
    if (rank < 0) continue;
    const cols = texts.flatMap((t, i) => (t === CODE_HEADERS[rank] ? [i] : []));
    if (cols.length > 1) throw inputError(`${where}, row ${r.row}, columns ${cols.map(letter).join(' and ')}: both are an account code column; keep one.`);
    if (TEMPLATE_HEADER.every((h) => texts.includes(h)) && (texts.includes('fy total') || texts.includes('py actual'))) {
      throw inputError(`${where}, row ${r.row}: this is an IsaFlow budget template without its hidden _meta and _base sheets; download a fresh one (get_budget_template format xlsx) and make your changes in it, `
        + 'since without them its blank cells would keep amounts instead of clearing them.');
    }
    return { header: r, texts: shown, codeCol: cols[0]! };
  }
  throw inputError(`${where}: no header row with an account code column ("Account code", "Code" or "Account") in rows 1 to ${HEADER_ROWS} of the sheet. Head the code column so, and one column per month.`);
}

export interface FreeformLines {
  lines: ImportLine[];
  /** Rows left out that hold no money (all month cells empty) or are total rows, by sheet row. */
  skipped: Array<{ row: number; reason: string }>;
  /** Rows refused before the resolver (money with no readable code, an error code, a lost leading zero), with the code as read. */
  errors: Array<ImportIssue & { account: string }>;
}

const NOT_CENTS = 'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)';
type Amount = ImportLine['amounts'][number];

/** A month cell: empty keeps, "clear" clears, text and plain numbers are amounts, anything else is refused. */
function amountCell(month: string, c: FreeCell | null | undefined): Amount {
  if (!c || (c.kind === 'text' && c.text.trim() === '')) return { month, cell: { kind: 'blank' }, keep: true };
  if (c.kind === 'bad') return { month, cell: { kind: 'error', raw: '', reason: `This cell is ${c.what}, not an amount.` } };
  if (c.kind === 'text') return c.text.trim().toLowerCase() === CLEAR_WORD ? { month, cell: { kind: 'blank' } } : { month, cell: amountOf(c.text) };
  if (!c.plain) {
    return { month, cell: { kind: 'error', raw: String(c.value), reason: `This cell's number format (${clip(c.format)}) is not a plain number, currency or accounting format (a date, time, percent or other), so it is not read as an amount; format it as a number.` } };
  }
  if (Math.abs(c.value * 100 - Math.round(c.value * 100)) >= 1e-6) return { month, cell: { kind: 'error', raw: String(c.value), reason: NOT_CENTS } };
  return { month, cell: amountOf(c.value) };
}

const dimensionText = (c: FreeCell | null | undefined): string => (c?.kind === 'text' ? codeOf(c.text) : c?.kind === 'number' ? String(c.value) : '');

/** The free-form sheet as import lines (`row` = the sheet row). Throws a BUDGET_VERSION_INPUT naming the sheet, row and column. */
export function freeformLines(model: GridReadModel, grain: TemplateGrain, sheet: FreeformSheet): FreeformLines {
  const months = model.year.monthKeys;
  const fy = model.year.fiscalYear;
  const where = `Sheet "${clip(sheet.name)}"`;
  const { header, texts, codeCol } = headerRow(sheet, where);
  const at = (col: number) => `${where}, row ${header.row}, column ${letter(col)}`;
  const monthCol = new Map<string, number>();
  const known = new Set<number>([codeCol]);
  let dimCol: number | null = null;
  texts.forEach((shown, col) => {
    const key = norm(shown);
    if (col === codeCol || key === '') return;
    known.add(col);
    if (CODE_HEADERS.includes(key) || IGNORED.has(key)) return;
    const kind = ANY_DIMENSION.includes(key) ? 'any' : (Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>).find((k) => DIMENSIONS[k].includes(key)) ?? null;
    if (kind !== null) {
      if (grain === 'company') throw inputError(`${at(col)}: "${clip(shown)}" names a dimension; a company-level import has none (send grain cc1, cc2 or bu).`);
      if (dimCol !== null) throw inputError(`${at(col)}: "${clip(shown)}" is a second dimension column; a budget amount carries at most one dimension (decision 14).`);
      if (kind !== 'any' && kind !== grain) throw inputError(`${at(col)}: "${clip(shown)}" is a ${GRAIN_LABEL[kind]} column; this is a ${GRAIN_LABEL[grain]} import (send grain ${kind}).`);
      dimCol = col;
      return;
    }
    const month = monthOfHeader(shown, months, fy);
    if (month === null) {
      throw inputError(`${at(col)}: "${clip(shown)}" is not an account code, dimension or month column of FY${fy} (${months[0]} to ${months[months.length - 1]}). `
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

  const find = codeIndex(model.accounts);
  const out: FreeformLines = { lines: [], skipped: [], errors: [] };
  for (const r of sheet.rows) {
    if (r.row <= header.row) continue;
    const stray = r.cells.findIndex((c, col) => c !== null && c !== undefined && !known.has(col));
    if (stray >= 0) throw inputError(`${where}, row ${r.row}, column ${letter(stray)}: a value under no header. Head the column or remove the value.`);
    const amounts = months.map((month) => amountCell(month, r.cells[monthCol.get(month)!]));
    const money = amounts.some((a) => !a.keep);
    const raw = r.cells[codeCol];
    const refuse = (message: string, account: string) => out.errors.push({ row: r.row, column: 'Account code', account, message: `${where}, row ${r.row}, column ${letter(codeCol)}: ${message}` });
    if (raw?.kind === 'bad') { refuse(`the account code is ${raw.what}, not a code.`, ''); continue; }
    const accountCode = raw?.kind === 'text' ? codeOf(raw.text) : raw?.kind === 'number' ? String(raw.value) : '';
    const code = accountCode.trim();
    if (code === '') {
      if (money) refuse('this row has amounts but no account code.', '');
      else out.skipped.push({ row: r.row, reason: 'no account code, and no amounts' });
      continue;
    }
    if (raw?.kind === 'number') {
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
      if (!money) { out.skipped.push({ row: r.row, reason: 'not an account, and no amounts (a heading?)' }); continue; }
    }
    out.lines.push({ row: r.row, accountCode, dimensionCode: dimCol === null ? null : dimensionText(r.cells[dimCol]), amounts });
  }
  return out;
}
