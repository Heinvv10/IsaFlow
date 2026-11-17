/**
 * Which kind of budget workbook an MCP upload is, and a free-form sheet's contents (MCP budget tools PR 2, review
 * rounds 2 to 4). Every part is PARSED (`budgetFreeformXml`, `budgetFreeformSheet`), never scanned by regex.
 *  - Sheet names are compared after NFKC, with format / zero-width characters and spaces stripped and case folded:
 *    any sheet whose name so read starts with "_" and is not exactly `_meta` or `_base` refuses the file (a renamed
 *    or look-alike hidden sheet would turn a template into a free-form sheet, whose blanks keep instead of clearing).
 *  - A sheet named exactly `_meta` or `_base`: an IsaFlow template, read by `readBudgetWorkbook` exactly as the app's
 *    import preview reads it (that path is unchanged).
 *  - Otherwise the sheet the workbook OPENS ON (activeTab, round 7: what the user saw last) is the free-form sheet;
 *    it must be visible (a workbook saved open on a hidden sheet is refused). A sheet state the reader does not know
 *    refuses the file.
 *  - The free-form sheet must have no hidden row or column (AutoFilter-hidden included). Its lowest merge is handed
 *    on: `freeformLines` refuses one on or below the header row.
 * The app's import route does not call this.
 */
import { openXlsxParts, worksheetPart } from '@/lib/xlsxNormalise';
import { looksLikeXlsx, SpreadsheetTooLargeError } from '@/lib/xlsxToCsv';
import { inputError } from './gridErrors';
import { BASE_SHEET, META_SHEET } from './budgetTemplateXlsx';
import { BUDGET_IMPORT_LIMITS, clip, readBudgetWorkbook, type BudgetWorkbook } from './budgetImportParse';
import { parseRels, parseSharedStrings, parseStyles, parseWorkbookXml } from './budgetFreeformXml';
import { parseSheetXml, type FreeRow } from './budgetFreeformSheet';

export interface FreeformSheet {
  name: string;
  rows: FreeRow[];
  /** The workbook's date system (headers written as dates). */
  date1904?: boolean;
  /** The merged range reaching lowest down the sheet (round 7: refused on or below the header row), if any. */
  merged?: { ref: string; lastRow: number } | null;
}

export type ImportWorkbook = { kind: 'template'; wb: BudgetWorkbook } | { kind: 'freeform'; sheet: FreeformSheet };

const TEMPLATE_SHEETS: readonly string[] = [META_SHEET, BASE_SHEET];
const STATES = new Set(['visible', 'hidden', 'veryhidden']);

/** A sheet name as compared: NFKC, no format / zero-width characters, no spaces, case folded. */
export const squashSheetName = (name: string): string => name.normalize('NFKC').replace(/[\p{Cf}\p{Z}\s]/gu, '').toLowerCase();

/** A rels target of a workbook-level part (styles, shared strings) as its zip path, or null. */
function bookPart(target: string): string | null {
  if (/^\/xl\/[\w.-]+\.xml$/.test(target)) return target.slice(1);
  return /^[\w.-]+\.xml$/.test(target) ? `xl/${target}` : null;
}

export async function readImportWorkbook(buf: Buffer, limits = BUDGET_IMPORT_LIMITS): Promise<ImportWorkbook> {
  if (!looksLikeXlsx(buf)) throw inputError('This file is not an Excel workbook (.xlsx). Send the budget template, or a sheet of account codes and months, saved as .xlsx.');
  const parts = await openXlsxParts(buf, limits.maxUncompressedBytes);
  const wb = parseWorkbookXml(parts.workbook);
  const lookalike = wb.sheets.find((s) => /^(?:_|\p{M})/u.test(squashSheetName(s.name)) && !TEMPLATE_SHEETS.includes(s.name));
  if (lookalike) {
    throw inputError(`This workbook has a sheet named "${clip(lookalike.name)}" that starts with "_" or a combining mark but is not IsaFlow's _meta or _base sheet exactly (a renamed or look-alike one), so IsaFlow cannot tell whether this is a template. `
      + 'Download a fresh template (get_budget_template format xlsx) and make your changes in it, or, for a free-form sheet, delete or rename that sheet.');
  }
  if (wb.sheets.some((s) => TEMPLATE_SHEETS.includes(s.name))) return { kind: 'template', wb: await readBudgetWorkbook(buf, limits) };
  const unknown = wb.sheets.find((s) => !STATES.has(s.state));
  if (unknown) throw inputError(`This workbook's sheet "${clip(unknown.name)}" has a state ("${clip(unknown.state)}") IsaFlow does not know; open it in Excel, save it again, and send it.`);
  const sheet = wb.sheets[wb.activeTab];
  if (sheet === undefined) throw inputError(`This workbook opens on sheet number ${wb.activeTab + 1}, which it does not have. Open it in Excel, save it open on the sheet to import, and send it again.`);
  if (sheet.state !== 'visible') {
    throw inputError(`This workbook opens on sheet "${clip(sheet.name)}", which is hidden; IsaFlow reads the sheet a workbook opens on. Unhide it, or save the workbook open on the sheet to import, and send it again.`);
  }
  const rels = parseRels(parts.rels);
  const target = sheet.rid === null ? undefined : rels.get(sheet.rid)?.target;
  const path = target === undefined ? null : worksheetPart(target);
  const part = path === null ? null : await parts.read(path);
  if (!part) throw inputError(`Sheet "${clip(sheet.name)}" is not a plain worksheet, so it cannot be read as a budget sheet.`);
  const of = (kind: string, fallback: string) => {
    const rel = [...rels.values()].find((r) => r.type.endsWith(`/${kind}`));
    return rel ? bookPart(rel.target) : fallback;
  };
  const tooLarge = (what: string) => () => new SpreadsheetTooLargeError(`This workbook's ${what} is larger than any budget sheet needs. Copy the cells into a new workbook and send that.`);
  const stylesPath = of('styles', 'xl/styles.xml');
  const sstPath = of('sharedStrings', 'xl/sharedStrings.xml');
  if (stylesPath === null || sstPath === null) throw inputError('This workbook\'s styles or shared strings are where no spreadsheet program writes them.');
  const styles = await parts.read(stylesPath, { bytes: limits.maxStylesBytes, refuse: tooLarge('cell formatting') });
  const sst = await parts.read(sstPath, { bytes: limits.maxSharedStringsBytes, refuse: tooLarge('text') });
  const read = parseSheetXml(part, sheet.name, parseSharedStrings(sst, limits.maxSharedStrings), parseStyles(styles), {
    maxRows: limits.maxRows, maxColumns: limits.maxColumns, maxOutputBytes: limits.maxOutputBytes,
  });
  if (read.hidden) {
    throw inputError(`Sheet "${clip(sheet.name)}" has hidden rows or columns (${read.hidden}): unhide every row and column, and clear any filter, so what IsaFlow imports is what you see; then send it again.`);
  }
  return { kind: 'freeform', sheet: { name: sheet.name, rows: read.rows, date1904: wb.date1904, merged: read.merged } };
}
