import { describe, it, expect } from 'vitest';
import {
  validateSaIdNumber,
  validateSaTaxNumber,
  extractDateOfBirthFromId,
  extractGenderFromId,
} from '@/modules/payroll/payrollValidationService';

describe('SA ID number validation', () => {
  it('accepts a known-valid SA ID', () => {
    const result = validateSaIdNumber('9202204720083');
    expect(result.valid).toBe(true);
  });

  it('rejects wrong length', () => {
    const result = validateSaIdNumber('920220472008');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/13 digits/);
  });

  it('rejects non-numeric', () => {
    const result = validateSaIdNumber('920220472008X');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/numeric/);
  });

  it('rejects invalid date-of-birth', () => {
    const result = validateSaIdNumber('9213204720087');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/date/i);
  });

  it('rejects bad Luhn checksum', () => {
    const result = validateSaIdNumber('9202204720081');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/checksum/i);
  });

  it('extracts date-of-birth as ISO string', () => {
    expect(extractDateOfBirthFromId('9202204720083')).toBe('1992-02-20');
  });

  it('extracts gender (female if pos 6 digit < 5)', () => {
    // Position 6 (index 6) of '9202204720083' is '4' → female
    expect(extractGenderFromId('9202204720083')).toBe('female');
  });
});

describe('SA tax number validation', () => {
  it('accepts 10-digit numeric tax number', () => {
    const result = validateSaTaxNumber('1234567890');
    expect(result.valid).toBe(true);
  });

  it('rejects tax number starting with zero', () => {
    const result = validateSaTaxNumber('0234567890');
    expect(result.valid).toBe(false);
  });

  it('rejects wrong length', () => {
    const result = validateSaTaxNumber('123456789');
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric', () => {
    const result = validateSaTaxNumber('12345678AB');
    expect(result.valid).toBe(false);
  });
});
