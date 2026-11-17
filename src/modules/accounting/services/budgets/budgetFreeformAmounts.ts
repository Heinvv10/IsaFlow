/**
 * A free-form budget sheet's month cells as amounts (MCP budget tools PR 2, review rounds 4, 5 and 7).
 *  - Blank KEEPS the version's amount; the text "clear" clears the month; text is an amount as the template import
 *    reads text (`amountOf`); a TRUE / FALSE, error, date or result-less formula cell is refused.
 *  - A number is an amount only when its format is one a money cell may carry (`formatDecimals`), and then:
 *    a format showing 0 or 1 decimals refuses a value it does not show in full (it would show 1 235 for 1 234.50);
 *    a format showing EXACTLY 2 decimals imports the value AS SHOWN (round 7: =annual/12 under #,##0.00), rounded half
 *    away from zero from its 15 significant digits as Excel and LibreOffice draw it (1.005 shows 1.01, 2.675 2.68), and
 *    the cell is listed (`onRound`) so the dry run says which cells were rounded; General, Text and formats showing
 *    more than 2 decimals refuse a value with more than 2 (what they show is not a whole number of cents).
 */
import { amountOf, clip, type ImportLine } from './budgetImportParse';
import type { FreeCell, FreeRow } from './budgetFreeformSheet';

/** The word a free-form cell holds to clear its month (a blank cell keeps it). */
export const CLEAR_WORD = 'clear';
export const NOT_CENTS = 'has more than 2 decimals; round it to cents in the sheet (a free-form sheet is not rounded for you)';
type Amount = ImportLine['amounts'][number];

/** Cents as decimal text (-8333.33). */
export const centsText = (cents: number): string => {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** A value in cents as a 2-decimal format shows it: its 15 significant digits, rounded half away from zero. */
export function shownCents(value: number): number {
  const [mantissa, exponent = '0'] = Math.abs(value).toPrecision(15).split('e');
  const digits = mantissa!.replace('.', '');
  const point = (mantissa!.includes('.') ? mantissa!.indexOf('.') : mantissa!.length) + Number(exponent);
  const padded = point <= 0 ? '0'.repeat(1 - point) + digits : digits.padEnd(point + 3, '0');
  const at = Math.max(point, 1);
  const cents = Number(padded.slice(0, at + 2)) + ((padded[at + 2] ?? '0') >= '5' ? 1 : 0);
  return value < 0 && cents > 0 ? -cents : cents;
}

/** True when the value is not a whole number at this scale (100: cents). */
const off = (value: number, scale: number) => Math.abs(value * scale - Math.round(value * scale)) >= 1e-6;

/** A month cell: empty keeps, "clear" clears, text and plain numbers are amounts, anything else is refused. */
export function amountCell(month: string, c: FreeCell | null | undefined, onRound?: (value: number, imported: string) => void): Amount {
  if (!c || (c.kind === 'text' && c.text.trim() === '')) return { month, cell: { kind: 'blank' }, keep: true };
  if (c.kind === 'bad') return { month, cell: { kind: 'error', raw: '', reason: `This cell is ${c.what}, not an amount.` } };
  if (c.kind === 'text' && c.text.trim().toLowerCase() === CLEAR_WORD) return { month, cell: { kind: 'blank' } };
  if (!c.plain) { // round 5: a text amount too (a ";;;" format hides what the cell holds)
    return { month, cell: { kind: 'error', raw: c.kind === 'text' ? c.text.slice(0, 40) : String(c.value), reason: `This cell's number format (${clip(c.format)}) is not a plain number, currency or accounting format (a date, time, percent or other), so it is not read as an amount; format it as a number.` } };
  }
  if (c.kind === 'text') return { month, cell: amountOf(c.text) };
  if (c.decimals < 2 && off(c.value, 10 ** c.decimals)) { // the format shows fewer places than the cell holds: shown is not imported
    return { month, cell: { kind: 'error', raw: String(c.value), reason: `This cell shows ${c.decimals} decimal place${c.decimals === 1 ? '' : 's'} but holds ${c.value}, so what you see is not what would be imported; format it with 2 decimals.` } };
  }
  if (off(c.value, 100)) {
    if (c.decimals !== 2) return { month, cell: { kind: 'error', raw: String(c.value), reason: NOT_CENTS } };
    const cents = shownCents(c.value);
    onRound?.(c.value, centsText(cents));
    return { month, cell: amountOf(cents / 100) };
  }
  return { month, cell: amountOf(c.value) };
}

/** A skipped total row's amounts as read (decimal text, or the cell's text), so the dry run shows what was left out. */
export function shownAmounts(months: readonly string[], r: FreeRow, monthCol: ReadonlyMap<string, number>): { amounts?: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const m of months) {
    const c = r.cells[monthCol.get(m)!];
    if (!c) continue;
    out[m] = c.kind === 'number' ? centsText(Math.round(c.value * 100)) : c.kind === 'text' ? clip(c.text) : c.what;
  }
  return Object.keys(out).length > 0 ? { amounts: out } : {};
}
