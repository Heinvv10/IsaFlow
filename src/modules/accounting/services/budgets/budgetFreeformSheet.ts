/**
 * A free-form budget sheet's worksheet part, parsed (MCP budget tools PR 2, review round 4): every cell with its own
 * type (`t`), value, formula presence and number format, so nothing is read as an amount that is not one (TRUE is
 * not 1, a date serial is not a number); the layout facts that refuse the file, wherever they are on the sheet: a
 * hidden row (AutoFilter-hidden included), a row lower than 3pt, every row hidden by default, a hidden column or one
 * narrower than one character (round 7: what cannot be read on screen is hidden); and the lowest merged range, which
 * the free-form reader refuses on or below the header row (round 7: a title merged above it is fine). Bounded as
 * the template import is (rows, columns, text).
 */
import { SpreadsheetTooLargeError } from '@/lib/xlsxToCsv';
import { inputError } from './gridErrors';
import { clip } from './budgetImportParse';
import { DXF_STYLE, misplaced, parseXml, truthy, type FormatOf } from './budgetFreeformXml';
import { formatDecimals } from './budgetFreeformFormats';

/** A cell as read: text, a number with its format (plain = General or a plain number format), or something that is neither. */
export type FreeCell =
  | { kind: 'text'; text: string; format: string; plain: boolean }
  | { kind: 'number'; value: number; format: string; plain: boolean; decimals: number }
  | { kind: 'bad'; what: string };

export interface FreeRow { row: number; cells: Array<FreeCell | null> }

export interface SheetXml {
  rows: FreeRow[];
  /** The first hidden layout found ("row 2", "column C", "every row"), or null. */
  hidden: string | null;
  /** The merged range reaching lowest down the sheet (`ref` as written; `lastRow` Infinity when unreadable), or null. */
  merged: { ref: string; lastRow: number } | null;
  /** Round 8: the conditional format reaching lowest whose style sets a number format, font or fill, or null. */
  conditional: { ref: string; lastRow: number } | null;
}

export interface SheetLimits { maxRows: number; maxColumns: number; maxOutputBytes: number }

export const columnLetter = (col: number): string => {
  let n = col + 1, out = '';
  while (n > 0) { out = String.fromCharCode(65 + ((n - 1) % 26)) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

function cellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col: col - 1 };
}

const BAD = {
  bool: 'a TRUE / FALSE value', date: 'a date', notNumber: (v: string) => `"${clip(v)}", which is not a number`, noResult: 'a formula with no saved result (open the file in Excel, save it, and send it again)',
  error: (v: string) => `an error value (${clip(v.trim(), 20)}: a formula that failed)`,
};

/** What SpreadsheetML puts inside each element of <sheetData> (round 5: anything else refuses the file). */
const SHEET_DATA: Readonly<Record<string, readonly string[]>> = {
  sheetData: ['row'], row: ['c'], c: ['f', 'v', 'is'], is: ['t', 'r', 'rPh', 'phoneticPr'], r: ['rPr', 't'], rPh: ['t'], f: [], v: [], t: [], phoneticPr: [],
};
/** A strict decimal: optional minus, digits, optional fraction, optional exponent (no whitespace, hex, Infinity, NaN). */
const DECIMAL = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM = 'http://schemas.microsoft.com/office/excel/2006/main';

/** The lowest row a merge or sqref range list reaches (space separated; Infinity for a whole column, or unreadable). */
const lastRowOf = (refs: string): number => {
  const parts = refs.trim().split(/\s+/).filter((r) => r !== '');
  if (parts.length === 0) return Infinity;
  return Math.max(...parts.map((r) => cellRef(r.split(':').at(-1)!.replace(/\$/g, ''))?.row ?? Infinity));
};
const MIN_WIDTH = 1;
const MIN_HEIGHT = 3;

export function parseSheetXml(part: Buffer, sheetName: string, sst: readonly string[], formatOf: FormatOf, limits: SheetLimits, dxfs: readonly boolean[] = []): SheetXml {
  const out: SheetXml = { rows: [], hidden: null, merged: null, conditional: null };
  const lowest = (key: 'merged' | 'conditional', ref: string, lastRow = lastRowOf(ref)) => {
    if (out[key] === null || lastRow > out[key]!.lastRow) out[key] = { ref, lastRow };
  };
  // Round 8: a conditional format, SpreadsheetML's (a cfRule names a dxf; one the styles lack counts as styling) or
  // Excel 2010's x14 inside extLst (its cfRule holds the dxf inline, its range is xm:sqref's text).
  let rule: { sqref: string; styled: boolean } | null = null;
  let x14: { sqref: string; styled: boolean; inDxf: number; inSqref: boolean } | null = null;
  const where = `Sheet "${clip(sheetName)}"`;
  const refuse = (message: string): never => { throw inputError(`${where}: ${message}`); };
  let row: FreeRow | null = null;
  let lastRow = 0, lastCol = -1, text = 0, rowCount = 0;
  let cell: { col: number; t: string; s: number; v: string; vs: number; f: boolean; inline: string } | null = null;
  const what = `${where}'s part`;
  const size = (v: string | undefined, label: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!DECIMAL.test(v.trim())) refuse(`its ${label} "${clip(v)}" is not a number.`);
    return Number(v);
  };
  const formatOfCell = (s: number) => formatOf(s) ?? refuse(`a cell names style ${s}, which the workbook does not define.`);

  const finish = (c: NonNullable<typeof cell>): FreeCell | null => {
    const count = (t: string) => { text += t.length + 1; if (text > limits.maxOutputBytes) throw new SpreadsheetTooLargeError(`This workbook holds more than ${Math.round(limits.maxOutputBytes / 1024 / 1024)} MB of text. Split the file and send each part.`); return t; };
    const textCell = (t: string): FreeCell => {
      const fmt = formatOfCell(c.s);
      return { kind: 'text', text: count(t), format: fmt.code ?? `built-in ${fmt.id}`, plain: formatDecimals(fmt.id, fmt.code) !== null };
    };
    switch (c.t) {
      case 's': {
        const s = /^\d+$/.test(c.v) ? sst[Number(c.v)] : undefined;
        if (c.vs === 0 || s === undefined) refuse(`a cell names shared text "${clip(c.v)}" the workbook does not hold.`);
        return textCell(s!);
      }
      case 'str': return c.f && c.vs === 0 ? { kind: 'bad', what: BAD.noResult } : textCell(c.v);
      case 'inlinestr': return textCell(c.inline);
      case 'b': return { kind: 'bad', what: BAD.bool };
      case 'e': return { kind: 'bad', what: BAD.error(c.v) };
      case 'd': return { kind: 'bad', what: BAD.date };
      case 'n': {
        if (c.vs === 0) return c.f ? { kind: 'bad', what: BAD.noResult } : null;
        const value = DECIMAL.test(c.v) ? Number(c.v) : NaN;
        if (!Number.isFinite(value)) return { kind: 'bad', what: BAD.notNumber(c.v) };
        const fmt = formatOfCell(c.s);
        const decimals = formatDecimals(fmt.id, fmt.code);
        return { kind: 'number', value, format: fmt.code ?? `built-in ${fmt.id}`, plain: decimals !== null, decimals: decimals ?? 0 };
      }
      default: return refuse(`a cell has a type ("${clip(c.t)}") IsaFlow does not read.`);
    }
  };

  parseXml(part, what, {
    open(name, a, parents) {
      const parent = parents.at(-1);
      if (parent !== undefined && parents.includes('sheetData') && SHEET_DATA[parent] && !SHEET_DATA[parent]!.includes(name)) throw misplaced(what, name, parent);
      if (parent === 'cols' && name !== 'col') throw misplaced(what, name, parent);
      if (name === 'sheetFormatPr') {
        const width = size(a.defaultColWidth, 'default column width'), height = size(a.defaultRowHeight, 'default row height');
        if (truthy(a.zeroHeight) || (height !== undefined && height < MIN_HEIGHT)) out.hidden ??= 'every row';
        if (width !== undefined && width < MIN_WIDTH) out.hidden ??= 'every column';
      } else if (name === 'col' && parent === 'cols') {
        const width = size(a.width, 'column width');
        if (truthy(a.hidden) || (width !== undefined && width < MIN_WIDTH)) out.hidden ??= `column ${columnLetter(Math.max(1, Number(a.min) || 1) - 1)}`;
      } else if (name === 'mergeCell') {
        const ref = a.ref ?? '(no range)';
        lowest('merged', ref, ref.includes(' ') ? Infinity : lastRowOf(ref));
      } else if (name === 'conditionalFormatting' && parent === 'worksheet') rule = { sqref: a.sqref ?? '', styled: false };
      else if (name === 'cfRule' && parent === 'conditionalFormatting' && rule && a.dxfId !== undefined) {
        if (!/^\d{1,9}$/.test(a.dxfId) || (dxfs[Number(a.dxfId)] ?? true)) rule.styled = true;
      }
      else if (name === 'row' && parent === 'sheetData') {
        const r = a.r === undefined ? lastRow + 1 : Number(a.r);
        if (!Number.isInteger(r) || r <= lastRow) refuse(`its rows are out of order (row ${clip(a.r ?? '')}), which Excel never writes.`);
        if (++rowCount > limits.maxRows) throw new SpreadsheetTooLargeError(`${where} has more than ${limits.maxRows} rows; IsaFlow imports at most ${limits.maxRows} at a time. Split the file and send each part.`);
        const height = size(a.ht, 'row height');
        if (truthy(a.hidden) || (height !== undefined && height < MIN_HEIGHT)) out.hidden ??= `row ${r}`;
        lastRow = r; lastCol = -1;
        row = { row: r, cells: [] };
      } else if (name === 'c' && parent === 'row' && row) {
        const at = a.r === undefined ? { row: row.row, col: lastCol + 1 } : cellRef(a.r);
        if (!at || at.row !== row.row || at.col <= lastCol) refuse(`cell ${clip(a.r ?? '?')} is not where its row says, which Excel never writes.`);
        if (at!.col >= limits.maxColumns) throw new SpreadsheetTooLargeError(`${where} has more than ${limits.maxColumns} columns; IsaFlow reads at most ${limits.maxColumns}. Remove the columns you do not need and send it again.`);
        lastCol = at!.col;
        const s = a.s === undefined ? 0 : Number(a.s);
        if (!Number.isInteger(s) || s < 0) refuse(`cell ${clip(a.r ?? '?')} names a style that is not a number.`);
        cell = { col: at!.col, t: (a.t ?? 'n').trim().toLowerCase(), s, v: '', vs: 0, f: false, inline: '' };
      } else if (cell && parent === 'c') {
        if (name === 'f') cell.f = true;
        if (name === 'v' && ++cell.vs > 1) refuse(`cell ${columnLetter(cell.col)}${row?.row ?? ''} holds more than one value, which Excel never writes.`);
      }
    },
    extOpen(uri, name, path) {
      if (uri === X14 && name === 'conditionalFormatting') x14 = { sqref: '', styled: false, inDxf: 0, inSqref: false };
      else if (x14 && uri === XM && name === 'sqref') x14.inSqref = true;
      else if (x14 && uri === X14 && name === 'dxf') x14.inDxf = path.length + 1;
      else if (x14 && x14.inDxf > 0 && path.length === x14.inDxf && DXF_STYLE.has(name)) x14.styled = true;
    },
    extText(t) {
      if (x14?.inSqref) x14.sqref += t;
    },
    extClose(uri, name) {
      if (x14 && uri === XM && name === 'sqref') x14.inSqref = false;
      else if (x14 && uri === X14 && name === 'dxf') x14.inDxf = 0;
      else if (x14 && uri === X14 && name === 'conditionalFormatting') {
        if (x14.styled) lowest('conditional', x14.sqref.trim() === '' ? '(no range)' : x14.sqref.trim());
        x14 = null;
      }
    },
    text(t, parents) {
      if (!cell) return;
      const here = parents.at(-1);
      if (here === 'v' && parents.at(-2) === 'c') cell.v += t;
      else if (here === 't' && (parents.at(-2) === 'is' || (parents.at(-2) === 'r' && parents.at(-3) === 'is'))) cell.inline += t;
    },
    close(name, parents) {
      if (name === 'conditionalFormatting' && rule) {
        if (rule.styled) lowest('conditional', rule.sqref.trim() === '' ? '(no range)' : rule.sqref.trim());
        rule = null;
      }
      if (name === 'c' && cell && row && parents.at(-1) === 'row') {
        const value = finish(cell);
        if (value !== null) row.cells[cell.col] = value;
        cell = null;
      } else if (name === 'row' && row) {
        if (row.cells.some((c) => c !== undefined && c !== null)) out.rows.push({ row: row.row, cells: Array.from(row.cells, (c) => c ?? null) });
        row = null;
      }
    },
  });
  return out;
}
