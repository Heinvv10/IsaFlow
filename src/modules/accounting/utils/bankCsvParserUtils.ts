/**
 * Bank CSV Parser — Shared Utilities
 * Low-level CSV parsing helpers shared by all bank-specific parsers.
 */

import { isRealCalendarDate } from '@/lib/validation';
import type { BankCsvParseResult } from '../types/bank.types';

/**
 * Parse a CSV string into lines, handling quoted fields.
 */
export function parseCsvLines(csv: string): string[][] {
  if (!csv || csv.trim() === '') return [];

  // Strip a UTF-8 BOM and normalise CRLF/CR — a stray \r otherwise rides along
  // on the last field of every row and defeats blank-row detection.
  const lines = csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split('\n');
  return lines.map(line => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim());
    return fields;
  });
}

/**
 * Parse amount string, handling thousand separators and negative values.
 *
 * Two conventions appear in SA bank exports and they disagree about the comma:
 *   1,234.56  — comma groups thousands (US/UK style)
 *   1 234,56  — space groups thousands, comma is the DECIMAL point (SA style)
 * Blindly stripping commas turned "1 234,56" into 123456 — a 100x overstatement
 * on every ABSA row that used the SA convention. Treat the comma as a decimal
 * point only when there is no dot and it is followed by exactly two digits.
 *
 * That heuristic is a deliberate tradeoff, not a parse: "1,00" is read as 1.00
 * rather than 100, because SA statement exports always carry cents. A file that
 * wrote whole rands as "1,00" meaning one hundred would be misread — no SA bank
 * export here does, and no rule can tell the two apart from the string alone.
 *
 * NOT handled, both returning null (the caller then rejects the row with an
 * "Invalid amount" parse error rather than guessing):
 *   "R 1,234.56"  — currency-prefixed
 *   "(123.45)"    — accounting-style negative in parentheses
 * Neither has turned up in an SA CSV export yet. Add them deliberately, with a
 * test, if one does.
 */
export function parseAmount(value: string): number | null {
  if (!value || value.trim() === '') return null;

  let cleaned = value.trim().replace(/^["']|["']$/g, '').trim();
  const decimalComma = !cleaned.includes('.') && /,\d{2}$/.test(cleaned);

  // `.replace(',', '.')` is NON-GLOBAL, so "1 234,56" was fine but "1,234,56"
  // converted only its first comma and parseFloat("1.234,56") stopped at 1.23
  // — a thousandfold under-read of the row, silently. Anchor the replacement on
  // the decimal comma and strip the rest.
  cleaned = decimalComma
    ? cleaned.replace(/[\s\u00A0]/g, '').replace(/,(?=\d{2}$)/, '.').replace(/,/g, '')
    : cleaned.replace(/[,\s\u00A0]/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * True when the row is padding rather than data: blank, or a total / closing-balance summary row (its FIRST cell says
 * so exactly). Shared by every CSV layout (round 3): an honest export with a trailing "Total" row or a blank line
 * otherwise reads as a skipped line and its balances as unverified. Narrow on purpose: any other row a parser cannot
 * read is still an error.
 */
export function isNoiseRow(fields: string[]): boolean {
  if (fields.every(f => f.trim() === '')) return true;
  const first = (fields[0] ?? '').trim().toLowerCase();
  return first === 'total' || first === 'totals' || first === 'closing balance';
}

// A plain number as SA exports print one: an optional leading sign, digits (optionally grouped by space, NBSP or
// comma), and an optional decimal part ('.' + 1-2 digits, or ',' + exactly 2, as parseAmount reads it).
const PLAIN_NUMBER = /^[+-]?(?:\d{1,3}(?:[\s\u00A0,]\d{3})+|\d+)(?:\.\d{1,2}|,\d{2})?$/;

/**
 * A running-balance cell, read strictly (WP1 PR-A review round 2). parseAmount is lenient — parseFloat stops at the
 * first character it cannot read, so "50.00 Dr" and "100.00-" read as +50 and +100 — and a sign-flipped balance
 * column can still chain (all amounts equal), storing a wrong opening/closing as 'running_balance'. A blank cell is
 * absent (undefined). Anything that is not a plain number (a Dr/Cr mark, a trailing or bracketed sign, a currency
 * symbol) leaves the line without a balance AND flags the file (`balancesUnverifiable`), so it is 'unverified'.
 * No CSV format here is known to mark balances with Dr/Cr, so none is read as a sign.
 */
export function readBalanceCell(result: BankCsvParseResult, fields: string[], index: number, row: number): number | undefined {
  if (fields.length <= index) return undefined;
  const raw = fields[index]!;
  const cell = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (cell === '') return undefined;
  const value = PLAIN_NUMBER.test(cell) ? parseAmount(cell) : null;
  if (value === null) {
    result.balancesUnverifiable ??= `row ${row}: balance "${cell.slice(0, 30)}" is not a plain number`;
    return undefined;
  }
  return value;
}

/**
 * Convert a date string to YYYY-MM-DD without knowing the layout up front.
 * Accepts YYYY/MM/DD, YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, and the ABSA
 * compact export format YYYYMMDD (8 digits, no separators): the four-digit
 * component decides which end the year sits on. Returns null when neither
 * component is a four-digit year, so callers with a known layout keep using
 * `normalizeDate`.
 *
 * A trailing four-digit year is assumed to be DD/MM/YYYY, never MM/DD/YYYY:
 * SA bank exports are day-first, and "03/04/2026" is 3 April, not 4 March.
 * Nothing in the string distinguishes the two below the 13th of the month, so
 * this is an assumption about the source, not a detection.
 *
 * The compact 8-digit form is checked BEFORE the separator split (splitting
 * "20260801" on `/`/`-` yields a single element, not 3, so it would otherwise
 * fall straight through to the `parts.length !== 3` null return). It is
 * validated with `isRealCalendarDate` — not just range-checked — so an
 * impossible date like "20261301" is rejected here rather than reaching a
 * `::DATE` cast downstream.
 */
export function normalizeDateFlexible(dateStr: string): string | null {
  const cleaned = dateStr.trim().replace(/^["']|["']$/g, '').trim();

  if (/^\d{8}$/.test(cleaned)) {
    // Compact YYYYMMDD (ABSA online-banking export). Bound the year so a
    // garbled 8-digit token (an account number, a DDMMYYYY value) cannot
    // pass as a "real" date in year 0108 or 9999.
    const year = Number(cleaned.slice(0, 4));
    if (year < 1990 || year > 2100) return null;
    const formatted = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
    return isRealCalendarDate(formatted) ? formatted : null;
  }

  const parts = cleaned.split(/[/-]/);
  if (parts.length !== 3) return null;

  if (parts[0]!.length === 4) return normalizeDate(cleaned, cleaned.includes('/') ? 'yyyy/mm/dd' : 'yyyy-mm-dd');
  if (parts[2]!.length === 4) {
    return normalizeDate(cleaned.replace(/-/g, '/'), 'dd/mm/yyyy');
  }
  return null;
}

/**
 * Convert date string to YYYY-MM-DD format.
 */
export function normalizeDate(
  dateStr: string,
  format: 'yyyy/mm/dd' | 'dd/mm/yyyy' | 'yyyy-mm-dd',
): string | null {
  const cleaned = dateStr.trim().replace(/^["']|["']$/g, '').trim();
  if (!cleaned) return null;

  let year: string, month: string, day: string;

  if (format === 'yyyy/mm/dd') {
    const parts = cleaned.split('/');
    if (parts.length !== 3) return null;
    year = parts[0]!; month = parts[1]!; day = parts[2]!;
  } else if (format === 'dd/mm/yyyy') {
    const parts = cleaned.split('/');
    if (parts.length !== 3) return null;
    day = parts[0]!; month = parts[1]!; year = parts[2]!;
  } else if (format === 'yyyy-mm-dd') {
    const parts = cleaned.split('-');
    if (parts.length !== 3) return null;
    year = parts[0]!; month = parts[1]!; day = parts[2]!;
  } else {
    return null;
  }

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
