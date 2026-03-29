/**
 * TDD: Receipt Photo → Expense Journal
 */

import { describe, it, expect } from 'vitest';
import {
  validateReceiptExtraction,
  mapMerchantToExpenseAccount,
  buildExpenseJournalFromReceipt,
  shouldAutoPostReceipt,
  parseReceiptType,
  type ReceiptAccountMapping,
  type ReceiptAutoPostConfig,
} from '@/modules/accounting/services/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const makeReceipt = (overrides?: Partial<ExtractedDocument>): ExtractedDocument => ({
  documentType: 'receipt',
  vendorName: 'Woolworths Sandton',
  vendorVatNumber: null,
  vendorAddress: null,
  vendorBankDetails: null,
  customerName: null,
  customerVatNumber: null,
  date: '2026-03-20',
  dueDate: null,
  paymentTerms: null,
  referenceNumber: 'REC-456',
  purchaseOrderRef: null,
  currency: 'ZAR',
  subtotal: 386.96,
  vatAmount: 58.04,
  vatRate: 15,
  totalAmount: 445.00,
  lineItems: [],
  rawText: '',
  confidence: 0.88,
  warnings: [],
  extractionMethod: 'vlm',
  ...overrides,
});

const accounts: ReceiptAccountMapping[] = [
  { id: 'gl-5100', code: '5100', name: 'Materials & Supplies' },
  { id: 'gl-5400', code: '5400', name: 'Transport & Fuel' },
  { id: 'gl-5600', code: '5600', name: 'Administrative Expenses' },
  { id: 'gl-5700', code: '5700', name: 'Bank Charges' },
];

describe('Receipt Validation', () => {
  it('rejects receipt with no totalAmount', () => {
    const r = validateReceiptExtraction(makeReceipt({ totalAmount: null }));
    expect(r.valid).toBe(false);
  });

  it('accepts receipt with totalAmount and date', () => {
    const r = validateReceiptExtraction(makeReceipt());
    expect(r.valid).toBe(true);
  });

  it('flags missing VAT as warning', () => {
    const r = validateReceiptExtraction(makeReceipt({ vatAmount: null }));
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('flags future date as error', () => {
    const r = validateReceiptExtraction(makeReceipt({ date: '2030-01-01' }));
    expect(r.valid).toBe(false);
  });
});

describe('Merchant to Account Mapping', () => {
  it('maps Woolworths to Materials & Supplies', () => {
    const m = mapMerchantToExpenseAccount('Woolworths Sandton', accounts);
    expect(m).not.toBeNull();
    expect(m!.code).toBe('5100');
  });

  it('maps Engen to Transport & Fuel', () => {
    const m = mapMerchantToExpenseAccount('ENGEN MIDRAND', accounts);
    expect(m).not.toBeNull();
    expect(m!.code).toBe('5400');
  });

  it('maps MTN to Administrative Expenses', () => {
    const m = mapMerchantToExpenseAccount('MTN RECHARGE', accounts);
    expect(m).not.toBeNull();
    expect(m!.code).toBe('5600');
  });

  it('returns null for unknown merchant', () => {
    const m = mapMerchantToExpenseAccount('Random Unknown Store', accounts);
    expect(m).toBeNull();
  });

  it('is case-insensitive', () => {
    const m = mapMerchantToExpenseAccount('engen fuel stop', accounts);
    expect(m).not.toBeNull();
  });
});

describe('Expense Journal Building', () => {
  it('creates DR Expense + DR VAT + CR Bank', () => {
    const j = buildExpenseJournalFromReceipt(makeReceipt(), { expenseAccountId: 'gl-5100', vatInputAccountId: 'gl-1140', bankAccountId: 'gl-1110' });
    expect(j.lines.length).toBe(3);
    const drExpense = j.lines.find(l => l.accountId === 'gl-5100');
    const drVat = j.lines.find(l => l.accountId === 'gl-1140');
    const crBank = j.lines.find(l => l.accountId === 'gl-1110');
    expect(drExpense!.debit).toBeCloseTo(386.96, 2);
    expect(drVat!.debit).toBeCloseTo(58.04, 2);
    expect(crBank!.credit).toBeCloseTo(445.00, 2);
  });

  it('uses extracted date as entry_date', () => {
    const j = buildExpenseJournalFromReceipt(makeReceipt(), { expenseAccountId: 'gl-5100', vatInputAccountId: 'gl-1140', bankAccountId: 'gl-1110' });
    expect(j.entryDate).toBe('2026-03-20');
  });

  it('includes merchant name in description', () => {
    const j = buildExpenseJournalFromReceipt(makeReceipt(), { expenseAccountId: 'gl-5100', vatInputAccountId: 'gl-1140', bankAccountId: 'gl-1110' });
    expect(j.description).toContain('Woolworths');
  });

  it('debits equal credits', () => {
    const j = buildExpenseJournalFromReceipt(makeReceipt(), { expenseAccountId: 'gl-5100', vatInputAccountId: 'gl-1140', bankAccountId: 'gl-1110' });
    const totalDr = j.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCr = j.lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(totalDr).toBeCloseTo(totalCr, 2);
  });

  it('calculates VAT from total when vatAmount is null', () => {
    const j = buildExpenseJournalFromReceipt(makeReceipt({ vatAmount: null, subtotal: null }), { expenseAccountId: 'gl-5100', vatInputAccountId: 'gl-1140', bankAccountId: 'gl-1110' });
    const drVat = j.lines.find(l => l.accountId === 'gl-1140');
    // 445 / 1.15 * 0.15 = 58.04
    expect(drVat!.debit).toBeCloseTo(58.04, 0);
  });
});

describe('Auto-Post Decision', () => {
  const config: ReceiptAutoPostConfig = { maxAmount: 5000, minConfidence: 0.85 };

  it('auto-posts when amount < R5000 and confidence >= 0.85', () => {
    expect(shouldAutoPostReceipt(445, 0.90, config)).toBe(true);
  });

  it('does not auto-post when amount >= R5000', () => {
    expect(shouldAutoPostReceipt(6000, 0.95, config)).toBe(false);
  });

  it('does not auto-post when confidence < 0.85', () => {
    expect(shouldAutoPostReceipt(445, 0.70, config)).toBe(false);
  });
});

describe('Receipt Type Classification', () => {
  it('classifies fuel station as fuel', () => {
    expect(parseReceiptType(makeReceipt({ vendorName: 'ENGEN FUEL STOP' }))).toBe('fuel');
  });

  it('classifies restaurant as meals', () => {
    expect(parseReceiptType(makeReceipt({ vendorName: 'SPUR STEAK RANCH' }))).toBe('meals');
  });

  it('classifies stationery as office_supplies', () => {
    expect(parseReceiptType(makeReceipt({ vendorName: 'PEN AND PAPER OFFICE NATIONAL' }))).toBe('office_supplies');
  });

  it('defaults to general', () => {
    expect(parseReceiptType(makeReceipt({ vendorName: 'RANDOM STORE XYZ' }))).toBe('general');
  });
});
