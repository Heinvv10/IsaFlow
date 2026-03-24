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

  if (line.debit < 0 || line.credit < 0) {
    return { valid: false, error: 'Debit and credit amounts cannot be negative' };
  }

  if (line.debit > 0 && line.credit > 0) {
    return { valid: false, error: 'A line must have either debit or credit, not both. One must be zero.' };
  }

  if (line.debit === 0 && line.credit === 0) {
    return { valid: false, error: 'A line must have a non-zero debit or credit amount' };
  }

  return { valid: true };
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
  const totalDebit = roundToCents(
    lines.reduce((sum, line) => sum + (line.debit || 0), 0)
  );
  const totalCredit = roundToCents(
    lines.reduce((sum, line) => sum + (line.credit || 0), 0)
  );
  const difference = roundToCents(Math.abs(totalDebit - totalCredit));

  if (difference > 0) {
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
