/**
 * Unit tests for accountLedgerCsv.ts
 * Verifies RFC 4180 CSV escaping: comma, quote, newline, and normal fields.
 */

import { describe, it, expect } from 'vitest';
import { csvField } from '@/lib/csv/accountLedgerCsv';

describe('csvField — RFC 4180 escaping', () => {
  it('wraps a normal field in double-quotes', () => {
    expect(csvField('hello')).toBe('"hello"');
  });

  it('does not alter an empty string', () => {
    expect(csvField('')).toBe('""');
  });

  it('escapes a comma-in-field by wrapping (comma preserved, field quoted)', () => {
    const result = csvField('Sales, Fees');
    // Comma inside quotes is valid CSV — no extra escaping needed
    expect(result).toBe('"Sales, Fees"');
    // Result has exactly 2 double-quotes (one open, one close)
    expect(result.split('"').length - 1).toBe(2);
  });

  it('doubles internal double-quotes', () => {
    const result = csvField('He said "hello"');
    // Internal " → "" inside the outer pair
    expect(result).toBe('"He said ""hello"""');
  });

  it('handles multiple internal double-quotes', () => {
    const result = csvField('"quoted" and "again"');
    expect(result).toBe('"""quoted"" and ""again"""');
  });

  it('wraps a field containing a newline', () => {
    const result = csvField('line1\nline2');
    expect(result).toBe('"line1\nline2"');
    // Newline is inside the quotes — no additional escaping
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
  });

  it('handles a field with both comma and quote', () => {
    const result = csvField('He said "yes, please"');
    expect(result).toBe('"He said ""yes, please"""');
  });
});
