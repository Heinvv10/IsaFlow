/**
 * PRD-060: FibreFlow Accounting Module
 * Double-Entry Validation Utilities
 *
 * Core validation logic for journal entries ensuring
 * fundamental accounting equation integrity.
 */

import type { JournalLineInput, JournalValidationResult, LineValidationResult } from '../types/gl.types';

/**
 * Validate a single journal line.
 * Rules:
 * - Must have a valid glAccountId
 * - Debit and credit must be >= 0
 * - Exactly one of debit/credit must be > 0 (not both, not neither)
 */
export function validateJournalLine(line: JournalLineInput): LineValidationResult {
  if (!line.glAccountId || line.glAccountId.trim() === '') {
    return { valid: false, error: 'GL account ID is required' };
  }

  // NaN compares false with everything, so it passed every rule below, Postgres numeric stores 'NaN', and
  // trg_gl_je_balanced let the entry post (NaN = NaN): every balance it touched became NaN (brk-nrfd, 2026-10-08).
  if (!isFiniteAmount(line.debit) || !isFiniteAmount(line.credit)) {
    return { valid: false, error: 'Debit and credit must be numbers' };
  }

  // Judged as stored: numeric(15,2) rounds each line to cents, so a 0.004 line is a 0.00 line (brk-nrfd round 3).
  const debit = storedCents(line.debit);
  const credit = storedCents(line.credit);

  if (debit < 0 || credit < 0) {
    return { valid: false, error: 'Debit and credit amounts cannot be negative' };
  }

  if (debit > 0 && credit > 0) {
    return { valid: false, error: 'A line must have either debit or credit, not both. One must be zero.' };
  }

  if (debit === 0 && credit === 0) {
    return { valid: false, error: 'A line must have a non-zero debit or credit amount' };
  }

  return { valid: true };
}

/** A decimal literal as Postgres numeric reads one ('10', '-0.5', '.5', '1e3'); not '', '0x10', 'NaN' or 'Infinity'. */
const DECIMAL_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** An absent amount is zero; a number must be finite; text must be a decimal literal. Nothing else is an amount. */
function isFiniteAmount(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && DECIMAL_TEXT.test(v) && Number.isFinite(Number(v));
}

/**
 * A line amount in whole cents as numeric(15,2) stores it: absent is zero; otherwise the decimal text the pg driver
 * sends (String(n) for a number) rounded half away from zero, read from its digits — n * 100 is binary
 * (1.005 * 100 = 100.49999…). Text is never concatenated ('0.10' + '0.20'). Only for amounts isFiniteAmount accepted.
 */
function storedCents(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const text = String(v).trim();
  if (/e/i.test(text)) {
    const n = Number(text);
    return Math.sign(n) * Math.round(Math.abs(n) * 100);
  }
  const negative = text.startsWith('-');
  const [whole = '', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const digits = `${fraction}000`;
  const cents = Number(whole || '0') * 100 + Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0);
  return negative ? -cents : cents;
}

/**
 * Validate an entire journal entry (set of lines).
 * Rules:
 * - Must have at least 2 lines
 * - Each line must pass individual validation
 * - Total debits must equal total credits (exact match, no tolerance)
 */
export function validateJournalEntry(lines: JournalLineInput[]): JournalValidationResult {
  const errors: string[] = [];

  if (!lines || lines.length === 0) {
    return {
      valid: false,
      totalDebit: 0,
      totalCredit: 0,
      difference: 0,
      errors: ['Journal entry must have at least one line'],
    };
  }

  if (lines.length < 2) {
    errors.push('Journal entry must have at least 2 lines for double-entry');
  }

  // Validate individual lines
  for (let i = 0; i < lines.length; i++) {
    const lineResult = validateJournalLine(lines[i]!);
    if (!lineResult.valid) {
      errors.push(`Line ${i + 1}: ${lineResult.error}`);
    }
  }

  // Calculate totals using fixed-point arithmetic to avoid floating-point issues
  // Summed as the lines are stored (whole cents), so the check agrees with trg_gl_je_balanced at post.
  const totalDebit = roundToCents(
    lines.reduce((sum, line) => sum + (isFiniteAmount(line.debit) ? storedCents(line.debit) : NaN), 0) / 100
  );
  const totalCredit = roundToCents(
    lines.reduce((sum, line) => sum + (isFiniteAmount(line.credit) ? storedCents(line.credit) : NaN), 0) / 100
  );
  const difference = roundToCents(Math.abs(totalDebit - totalCredit));

  // A NaN difference compares false with 0: refuse it rather than pass it as balanced.
  if (!Number.isFinite(difference)) {
    errors.push('Entry totals are not numbers');
  } else if (difference > 0) {
    errors.push(
      `Entry is not balanced: total debit R${totalDebit.toFixed(2)} != total credit R${totalCredit.toFixed(2)} (difference: R${difference.toFixed(2)})`
    );
  }

  return {
    valid: errors.length === 0,
    totalDebit,
    totalCredit,
    difference,
    errors,
  };
}

/**
 * Generate a journal entry number in format JE-YYYY-NNNNN
 */
export function formatJournalEntryNumber(year: number, sequence: number): string {
  return `JE-${year}-${String(sequence).padStart(5, '0')}`;
}

/**
 * Generate a supplier payment number in format PAY-YYYY-NNNNN
 */
export function formatPaymentNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(5, '0')}`;
}

/**
 * Round to 2 decimal places (cents) to avoid floating-point arithmetic issues
 */
export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
