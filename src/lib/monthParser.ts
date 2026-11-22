/**
 * Typed month entry for MonthField: "2026-03", "03/2026", "3 2026", "032026", "mar 2026", "maart", "mar 26", a bare
 * "3" (that month of this year), "t" (this month) and "+2" / "-1" (months from this one). Day-free, South African day
 * for "this month". Emits 'YYYY-MM'. Names reuse the date parser's English and Afrikaans table.
 */
import { expandYear, monthFromName, todayInSast } from './saDateParser';

export type MonthParseResult = { ok: true; ym: string } | { ok: false; reason: string };

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOW = 'Type a month like Mar 2026, 03/2026 or just 3 for March of this year.';

const ym = (year: number, month: number): string => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
const refuse = (reason: string): MonthParseResult => ({ ok: false, reason });

function build(year: number, month: number): MonthParseResult {
  if (!Number.isInteger(month) || month < 1 || month > 12) return refuse(`"${month}" is not a month. ${HOW}`);
  if (year < MIN_YEAR || year > MAX_YEAR) return refuse(`The year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  return { ok: true, ym: ym(year, month) };
}

/** 'Mar 2026' for 'YYYY-MM'; '' for anything else. */
export function formatMonth(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  const name = m ? SHORT[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : '';
}

export function parseMonth(input: string, now: Date = new Date()): MonthParseResult {
  const text = input.trim().toLowerCase();
  const [ty, tm] = todayInSast(now).split('-').map(Number) as [number, number];
  if (text === 't' || text === 'today') return build(ty, tm);

  const offset = /^([+-])(\d{1,3})$/.exec(text);
  if (offset) {
    const idx = ty * 12 + (tm - 1) + (offset[1] === '-' ? -1 : 1) * Number(offset[2]);
    return build(Math.floor(idx / 12), (idx % 12) + 1);
  }

  const iso = /^(\d{4})[-/.](\d{1,2})$/.exec(text);
  if (iso) return build(Number(iso[1]), Number(iso[2]));
  const mmyyyy = /^(\d{1,2})[-/. ]+(\d{4})$/.exec(text);
  if (mmyyyy) return build(Number(mmyyyy[2]), Number(mmyyyy[1]));
  const packed = /^(\d{2})(\d{4})$/.exec(text);
  if (packed) {
    // mmyyyy (032026), else yyyymm (202603) when the first two digits cannot be a month
    return Number(packed[1]) <= 12 ? build(Number(packed[2]), Number(packed[1])) : build(Number(`${packed[1]}${packed[2]?.slice(0, 2)}`), Number(packed[2]?.slice(2)));
  }

  const named = /^([a-z]+)\.?(?:[-/ ]*(\d{4}|\d{2}))?$/.exec(text);
  if (named) {
    const month = monthFromName(named[1] ?? '');
    if (month === null) return refuse(`"${input.trim()}" is not a month. ${HOW}`);
    return build(named[2] ? expandYear(named[2], ty) : ty, month);
  }

  if (/^\d{1,2}$/.test(text)) return build(ty, Number(text));
  return refuse(`"${input.trim()}" is not a month. ${HOW}`);
}

/** 'YYYY-MM' shifted by `n` months (negative goes back). */
export function addMonths(value: string, n: number): string {
  const [y, m] = value.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return ym(Math.floor(idx / 12), (idx % 12) + 1);
}

/** Pins `value` into [min, max] ('YYYY-MM', either optional). */
export function clampMonth(value: string, min?: string, max?: string): string {
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
}
