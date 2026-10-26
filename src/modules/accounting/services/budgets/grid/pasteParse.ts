/**
 * Clipboard text (TSV, as Excel and Sheets put it on the clipboard) → a matrix
 * of parsed cells. Only the TSV shape is ours. Each cell's amount is the kit
 * parser's (`parseSaAmount`, what MoneyField uses): it refuses ambiguous input
 * such as "1,234" with a reason rather than guessing (SimplePay R25 rule). A
 * refused cell is reported and never written. Do not add a money parser here.
 */
import { parseSaAmount } from '@/lib/money/saAmountParser';

export type ParsedCell =
  | { kind: 'value'; cents: number }
  /** Empty: the cell is cleared (not budgeted). */
  | { kind: 'blank' }
  | { kind: 'error'; raw: string; reason: string };

export interface ParseError {
  row: number;
  col: number;
  raw: string;
  reason: string;
}

export interface ParsedClipboard {
  rows: ParsedCell[][];
  errors: ParseError[];
  /** Set when the text is over MAX_PASTE_CHARS: nothing was parsed. */
  tooLarge?: boolean;
}

/** A 250-account × 15-month block is ~60 KB; 2 MB is far past any real paste and bounds the work. */
export const MAX_PASTE_CHARS = 2_000_000;

/** Excel's accounting format shows zero as a lone dash; so does the grid (en dash). */
const LONE_DASH = /^[-−–]$/;

export function parseCell(raw: string): ParsedCell {
  // A line break or tab inside one (quoted) cell is two values run together, never one amount.
  if (/[\t\r\n]/.test(raw.trim())) return { kind: 'error', raw, reason: 'This cell holds more than one line.' };
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return { kind: 'blank' };
  if (LONE_DASH.test(text)) return { kind: 'value', cents: 0 };
  const r = parseSaAmount(text);
  return r.ok ? { kind: 'value', cents: r.cents } : { kind: 'error', raw, reason: r.reason };
}

/** Index just past the closing quote of the quoted field opening at `open`, or -1 if it never closes. */
function closingQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (text[i + 1] === '"') { i++; continue; }
    return i + 1;
  }
  return -1;
}

/**
 * TSV fields, Excel style: a field that starts with `"` is quoted (`""` is a
 * quote; tabs and newlines inside it are data). A quote that never closes is
 * an ordinary character, so it cannot swallow the rows after it. Rows end at
 * CRLF, LF or CR.
 */
function splitTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (field === '' && ch === '"' && closingQuote(text, i) > 0) {
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        field += text[i++];
      }
      continue;
    }
    if (ch === '\t') { endField(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  endRow();
  return rows;
}

export function parseClipboard(text: string): ParsedClipboard {
  if (text === '') return { rows: [], errors: [] };
  if (text.length > MAX_PASTE_CHARS) return { rows: [], errors: [], tooLarge: true };
  const fields = splitTsv(text);
  // Excel ends a copied block with one newline: that last "row" is not data.
  const last = fields[fields.length - 1];
  if (fields.length > 1 && last?.length === 1 && last[0] === '') fields.pop();
  const errors: ParseError[] = [];
  const rows = fields.map((cols, r) => cols.map((raw, c) => {
    const cell = parseCell(raw);
    if (cell.kind === 'error') errors.push({ row: r, col: c, raw: cell.raw, reason: cell.reason });
    return cell;
  }));
  return { rows, errors };
}
