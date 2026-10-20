/**
 * TDD: EFT File Generation Tests for SA Banks
 * Written BEFORE implementation — RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  generateStandardBankACB,
  generateFNBEFT,
  generateABSAEFT,
  generateNedbankEFT,
  generateCapitecEFT,
  validateBankAccount,
  validateEFTBatch,
  eftTruncationWarnings,
  formatEFTAmount,
  padRight,
  padLeft,
  type EFTPayment,
  type EFTBatchHeader,
  type EFTValidationResult,
} from '@/modules/accounting/services/ap/eftService';

// ═══════════════════════════════════════════════════════════════════════════
// SHARED TEST DATA
// ═══════════════════════════════════════════════════════════════════════════

const sampleHeader: EFTBatchHeader = {
  companyName: 'IsaFlow Test Pty Ltd',
  bankAccountNumber: '1234567890',
  branchCode: '250655',
  accountType: 'current',
  batchReference: 'BATCH-001',
  actionDate: '2026-04-01',
};

const samplePayments: EFTPayment[] = [
  {
    beneficiaryName: 'Supplier One',
    beneficiaryAccountNumber: '9876543210',
    beneficiaryBranchCode: '632005',
    beneficiaryAccountType: 'current',
    amount: 15000.50,
    reference: 'INV-001',
    beneficiaryBank: 'fnb',
  },
  {
    beneficiaryName: 'Supplier Two',
    beneficiaryAccountNumber: '1111222233',
    beneficiaryBranchCode: '051001',
    beneficiaryAccountType: 'savings',
    amount: 8250.00,
    reference: 'INV-002',
    beneficiaryBank: 'standard_bank',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// STANDARD BANK ACB FORMAT
// ═══════════════════════════════════════════════════════════════════════════

describe('Standard Bank ACB Format', () => {
  it('generates valid ACB file content', () => {
    const result = generateStandardBankACB(sampleHeader, samplePayments);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains header record', () => {
    const result = generateStandardBankACB(sampleHeader, samplePayments);
    const lines = result.split('\n');
    expect(lines[0]).toBeDefined();
    // ACB header starts with specific identifier
    expect(lines[0]!.length).toBeGreaterThan(0);
  });

  it('contains correct number of transaction records', () => {
    const result = generateStandardBankACB(sampleHeader, samplePayments);
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    // Header + 2 transactions + trailer = 4 lines
    expect(lines.length).toBe(4);
  });

  it('contains trailer with correct totals', () => {
    const result = generateStandardBankACB(sampleHeader, samplePayments);
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    const trailer = lines[lines.length - 1]!;
    // Trailer should contain total amount: 15000.50 + 8250.00 = 23250.50
    expect(trailer).toContain('2325050'); // Amount in cents
  });

  it('handles empty payments', () => {
    const result = generateStandardBankACB(sampleHeader, []);
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    // Header + trailer only
    expect(lines.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FNB EFT FORMAT
// ═══════════════════════════════════════════════════════════════════════════

describe('FNB EFT Format', () => {
  it('generates valid FNB file content', () => {
    const result = generateFNBEFT(sampleHeader, samplePayments);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('contains header, transactions, and trailer', () => {
    const result = generateFNBEFT(sampleHeader, samplePayments);
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(4); // header + 2 tx + trailer
  });

  it('formats amounts in cents (no decimals)', () => {
    const result = generateFNBEFT(sampleHeader, samplePayments);
    // R15,000.50 should appear as 1500050
    expect(result).toContain('1500050');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ABSA EFT FORMAT
// ═══════════════════════════════════════════════════════════════════════════

describe('ABSA EFT Format', () => {
  it('generates valid ABSA file', () => {
    const result = generateABSAEFT(sampleHeader, samplePayments);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains correct number of records', () => {
    const lines = generateABSAEFT(sampleHeader, samplePayments).split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NEDBANK EFT FORMAT
// ═══════════════════════════════════════════════════════════════════════════

describe('Nedbank EFT Format', () => {
  it('generates valid Nedbank file', () => {
    const result = generateNedbankEFT(sampleHeader, samplePayments);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('contains correct record count', () => {
    const lines = generateNedbankEFT(sampleHeader, samplePayments).split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAPITEC EFT FORMAT
// ═══════════════════════════════════════════════════════════════════════════

describe('Capitec EFT Format', () => {
  it('generates valid Capitec file', () => {
    const result = generateCapitecEFT(sampleHeader, samplePayments);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('contains correct record count', () => {
    const lines = generateCapitecEFT(sampleHeader, samplePayments).split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BANK ACCOUNT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Bank Account Validation', () => {
  it('validates valid SA account number', () => {
    const result = validateBankAccount('1234567890', '250655');
    expect(result.valid).toBe(true);
  });

  it('rejects empty account number', () => {
    expect(validateBankAccount('', '250655').valid).toBe(false);
  });

  it('rejects empty branch code', () => {
    expect(validateBankAccount('1234567890', '').valid).toBe(false);
  });

  it('rejects account number with letters', () => {
    expect(validateBankAccount('12345ABCDE', '250655').valid).toBe(false);
  });

  it('rejects branch code with wrong length', () => {
    expect(validateBankAccount('1234567890', '12345').valid).toBe(false);
  });

  it('accepts 6-digit branch code', () => {
    expect(validateBankAccount('1234567890', '250655').valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EFT BATCH VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('EFT Batch Validation', () => {
  it('validates valid batch', () => {
    const result = validateEFTBatch(sampleHeader, samplePayments);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects empty payments', () => {
    const result = validateEFTBatch(sampleHeader, []);
    expect(result.valid).toBe(false);
  });

  it('rejects payment with zero amount', () => {
    const result = validateEFTBatch(sampleHeader, [{ ...samplePayments[0]!, amount: 0 }]);
    expect(result.valid).toBe(false);
  });

  it('rejects payment with negative amount', () => {
    const result = validateEFTBatch(sampleHeader, [{ ...samplePayments[0]!, amount: -100 }]);
    expect(result.valid).toBe(false);
  });

  it('rejects payment with missing beneficiary name', () => {
    const result = validateEFTBatch(sampleHeader, [{ ...samplePayments[0]!, beneficiaryName: '' }]);
    expect(result.valid).toBe(false);
  });

  it('rejects payment with missing account number', () => {
    const result = validateEFTBatch(sampleHeader, [{ ...samplePayments[0]!, beneficiaryAccountNumber: '' }]);
    expect(result.valid).toBe(false);
  });

  it('rejects a header with no originating account or branch (AP-02: never zeros)', () => {
    expect(validateEFTBatch({ ...sampleHeader, bankAccountNumber: '' }, samplePayments).valid).toBe(false);
    expect(validateEFTBatch({ ...sampleHeader, branchCode: '' }, samplePayments).valid).toBe(false);
    expect(validateEFTBatch({ ...sampleHeader, branchCode: '2506' }, samplePayments).valid).toBe(false);
  });

  it('rejects a header whose action date is not YYYY-MM-DD', () => {
    expect(validateEFTBatch({ ...sampleHeader, actionDate: 'Tue Sep 01 2026' }, samplePayments).valid).toBe(false);
  });

  it('rejects a payee with a blank or malformed branch code instead of padding it to 000000 (AP-36)', () => {
    for (const branch of ['', '  ', '25065', '25065a']) {
      const result = validateEFTBatch(sampleHeader, [{ ...samplePayments[0]!, beneficiaryBranchCode: branch }]);
      expect(result.valid, branch).toBe(false);
      expect(result.errors.join()).toMatch(/Branch code/);
    }
  });

  it('rejects a payee account longer than 11 digits (padLeft would keep the last 11) or with non-digits', () => {
    for (const account of ['123456789012', '12-3456']) {
      const result = validateEFTBatch(sampleHeader, [{ ...samplePayments[0]!, beneficiaryAccountNumber: account }]);
      expect(result.valid, account).toBe(false);
    }
  });

  it('rejects an originating account longer than 11 digits', () => {
    expect(validateEFTBatch({ ...sampleHeader, bankAccountNumber: '123456789012' }, samplePayments).valid).toBe(false);
    expect(validateBankAccount('123456789012', '250655').valid).toBe(false);
  });

  it('rejects an amount or total that overflows its field, and takes the largest that fits', () => {
    const pay = (amount: number) => ({ ...samplePayments[0]!, amount });
    expect(validateEFTBatch(sampleHeader, [pay(1_000_000_000)]).valid).toBe(false);
    expect(validateEFTBatch(sampleHeader, [pay(999_999_999.99)]).valid).toBe(true);
    expect(validateEFTBatch(sampleHeader, Array.from({ length: 11 }, () => pay(999_999_999.99))).valid).toBe(false);
  });

  it('reports the text each format cuts, and nothing for Capitec', () => {
    const long = { ...samplePayments[0]!, beneficiaryName: 'N'.repeat(31), reference: 'R'.repeat(13) };
    expect(eftTruncationWarnings('fnb', sampleHeader, [long])).toHaveLength(2);
    expect(eftTruncationWarnings('standard_bank', sampleHeader, [long])).toHaveLength(1);
    expect(eftTruncationWarnings('capitec', sampleHeader, [long])).toEqual([]);
    expect(eftTruncationWarnings('fnb', sampleHeader, samplePayments)).toEqual([]);
  });

  it('calculates correct batch total', () => {
    const result = validateEFTBatch(sampleHeader, samplePayments);
    expect(result.totalAmount).toBe(23250.50);
    expect(result.paymentCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

describe('EFT Formatting Utilities', () => {
  it('formats amount to cents (no decimals)', () => {
    expect(formatEFTAmount(15000.50)).toBe('1500050');
    expect(formatEFTAmount(100)).toBe('10000');
    expect(formatEFTAmount(0.01)).toBe('1');
    expect(formatEFTAmount(0)).toBe('0');
  });

  it('pads right with spaces', () => {
    expect(padRight('ABC', 10)).toBe('ABC       ');
    expect(padRight('ABCDEFGHIJ', 5)).toBe('ABCDE');
  });

  it('pads left with zeros', () => {
    expect(padLeft('123', 10)).toBe('0000000123');
    expect(padLeft('1234567890', 5)).toBe('67890');
  });
});
