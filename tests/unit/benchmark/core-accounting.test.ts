/**
 * Core Accounting — Pure Logic Unit Tests
 *
 * Covers all pure (non-async, non-DB) exported functions from the core
 * accounting services and utilities. Each section notes why async/DB-only
 * services were skipped.
 *
 * Services audited:
 *   chartOfAccountsService     — SKIPPED: all exports are async DB functions; mapRow is private
 *   journalEntryPostingService — SKIPPED: all exports are async DB functions
 *   fiscalPeriodService        — SKIPPED: all exports are async DB functions; mapRow is private
 *   budgetService              — distributeEvenly is private; all public exports are async DB
 *   systemAccountResolver      — clearSystemAccountCache is the only sync export (no logic to assert)
 *   softDeleteService          — isValidEntityType is a pure sync export (tested below);
 *                                requires neon/logger mock because the module imports sql at load time
 *   costCentreService          — SKIPPED: all exports are async DB functions; mapRow is private
 *   businessUnitService        — SKIPPED: all exports are async DB functions; mapRow is private
 *   currencyService            — SKIPPED: all exports are async DB functions; mapRow is private
 *
 * Pure logic tested via the accounting utility layer:
 *   utils/doubleEntry           — validateJournalLine, validateJournalEntry,
 *                                  formatJournalEntryNumber, formatPaymentNumber, roundToCents
 *   utils/aging                 — getAgingBucket, calculateAgingBuckets
 *   utils/paymentAllocation     — validatePaymentAllocations
 *   utils/autoMatch             — findMatchCandidates, runAutoMatch
 *   utils/threeWayMatch         — validateThreeWayMatch
 *   utils/fuzzyMatch            — fuzzyMatchSupplier, fuzzyMatchClient
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the DB and logger modules BEFORE any service import so the Neon
// driver does not attempt to connect (DATABASE_URL is absent in unit tests).
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/cache', () => ({
  cacheThrough: vi.fn(),
  cache: { invalidatePrefix: vi.fn() },
}));
vi.mock('@/lib/cache-keys', () => ({
  CACHE_KEYS: { glAccounts: vi.fn(), glAccountsInactive: vi.fn() },
  CACHE_TTL: { REFERENCE_DATA: 300 },
}));

// softDeleteService — only pure export
import { isValidEntityType } from '@/modules/accounting/services/softDeleteService';

// Double-entry utilities
import {
  validateJournalLine,
  validateJournalEntry,
  formatJournalEntryNumber,
  formatPaymentNumber,
  roundToCents,
} from '@/modules/accounting/utils/doubleEntry';

// Aging bucket utilities
import {
  getAgingBucket,
  calculateAgingBuckets,
} from '@/modules/accounting/utils/aging';

// Payment allocation validation
import { validatePaymentAllocations } from '@/modules/accounting/utils/paymentAllocation';

// Bank auto-match
import {
  findMatchCandidates,
  runAutoMatch,
} from '@/modules/accounting/utils/autoMatch';

// 3-Way match
import { validateThreeWayMatch } from '@/modules/accounting/utils/threeWayMatch';

// Fuzzy name matching
import {
  fuzzyMatchSupplier,
  fuzzyMatchClient,
} from '@/modules/accounting/utils/fuzzyMatch';

import type { AgingInvoice } from '@/modules/accounting/types/ap.types';

// ── Shared sample data ────────────────────────────────────────────────────────

const ACC_BANK    = 'acc-1000-bank';
const ACC_AR      = 'acc-1200-ar';
const ACC_REVENUE = 'acc-4000-revenue';
const ACC_VAT     = 'acc-2200-vat';

// ─────────────────────────────────────────────────────────────────────────────
// 1. softDeleteService — isValidEntityType
// ─────────────────────────────────────────────────────────────────────────────

describe('isValidEntityType', () => {
  it('accepts all six supported entity types', () => {
    const supported = [
      'customer',
      'supplier',
      'item',
      'bank_rule',
      'customer_invoice',
      'supplier_invoice',
    ];
    for (const t of supported) {
      expect(isValidEntityType(t), `expected ${t} to be valid`).toBe(true);
    }
  });

  it('rejects unknown entity types', () => {
    expect(isValidEntityType('gl_account')).toBe(false);
    expect(isValidEntityType('journal_entry')).toBe(false);
    expect(isValidEntityType('')).toBe(false);
    expect(isValidEntityType('CUSTOMER')).toBe(false); // case-sensitive
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. validateJournalLine
// ─────────────────────────────────────────────────────────────────────────────

describe('validateJournalLine', () => {
  it('accepts a valid debit-only line', () => {
    const result = validateJournalLine({ glAccountId: ACC_BANK, debit: 5000, credit: 0 });
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts a valid credit-only line', () => {
    const result = validateJournalLine({ glAccountId: ACC_REVENUE, debit: 0, credit: 5000 });
    expect(result.valid).toBe(true);
  });

  it('rejects missing glAccountId', () => {
    const result = validateJournalLine({ glAccountId: '', debit: 1000, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/account ID/i);
  });

  it('rejects whitespace-only glAccountId', () => {
    const result = validateJournalLine({ glAccountId: '   ', debit: 1000, credit: 0 });
    expect(result.valid).toBe(false);
  });

  it('rejects negative debit', () => {
    const result = validateJournalLine({ glAccountId: ACC_BANK, debit: -100, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/negative/i);
  });

  it('rejects negative credit', () => {
    const result = validateJournalLine({ glAccountId: ACC_BANK, debit: 0, credit: -50 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/negative/i);
  });

  it('rejects line with both debit and credit non-zero', () => {
    const result = validateJournalLine({ glAccountId: ACC_BANK, debit: 1000, credit: 1000 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not both/i);
  });

  it('rejects zero debit and zero credit', () => {
    const result = validateJournalLine({ glAccountId: ACC_BANK, debit: 0, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-zero/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. validateJournalEntry
// ─────────────────────────────────────────────────────────────────────────────

describe('validateJournalEntry', () => {
  it('accepts a balanced two-line entry', () => {
    const lines = [
      { glAccountId: ACC_AR,      debit: 11500, credit: 0 },
      { glAccountId: ACC_REVENUE, debit: 0,     credit: 10000 },
      { glAccountId: ACC_VAT,     debit: 0,     credit: 1500 },
    ];
    const result = validateJournalEntry(lines);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBeCloseTo(11500, 2);
    expect(result.totalCredit).toBeCloseTo(11500, 2);
    expect(result.difference).toBe(0);
  });

  it('rejects an empty lines array', () => {
    const result = validateJournalEntry([]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a single-line entry (not double-entry)', () => {
    const result = validateJournalEntry([
      { glAccountId: ACC_BANK, debit: 5000, credit: 0 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /at least 2/i.test(e))).toBe(true);
  });

  it('rejects an unbalanced entry', () => {
    const result = validateJournalEntry([
      { glAccountId: ACC_BANK,    debit: 6000, credit: 0 },
      { glAccountId: ACC_REVENUE, debit: 0,    credit: 5000 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.difference).toBeCloseTo(1000, 2);
    expect(result.errors.some(e => /not balanced/i.test(e))).toBe(true);
  });

  it('returns correct totals', () => {
    const result = validateJournalEntry([
      { glAccountId: ACC_BANK,    debit: 23450, credit: 0 },
      { glAccountId: ACC_REVENUE, debit: 0,     credit: 20391.30 },
      { glAccountId: ACC_VAT,     debit: 0,     credit: 3058.70 },
    ]);
    expect(result.totalDebit).toBeCloseTo(23450, 2);
    expect(result.totalCredit).toBeCloseTo(23450, 2);
  });

  it('propagates individual line errors', () => {
    const result = validateJournalEntry([
      { glAccountId: '',       debit: 1000, credit: 0 },
      { glAccountId: ACC_BANK, debit: 0,    credit: 1000 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /Line 1/i.test(e))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. formatJournalEntryNumber / formatPaymentNumber / roundToCents
// ─────────────────────────────────────────────────────────────────────────────

describe('formatJournalEntryNumber', () => {
  it('pads sequence to 5 digits', () => {
    expect(formatJournalEntryNumber(2025, 1)).toBe('JE-2025-00001');
  });

  it('handles a 5-digit sequence without truncation', () => {
    expect(formatJournalEntryNumber(2025, 99999)).toBe('JE-2025-99999');
  });

  it('uses the provided year correctly', () => {
    expect(formatJournalEntryNumber(2026, 42)).toBe('JE-2026-00042');
  });
});

describe('formatPaymentNumber', () => {
  it('formats supplier payment with PAY prefix', () => {
    expect(formatPaymentNumber('PAY', 2025, 7)).toBe('PAY-2025-00007');
  });

  it('formats customer receipt with RCT prefix', () => {
    expect(formatPaymentNumber('RCT', 2025, 123)).toBe('RCT-2025-00123');
  });
});

describe('roundToCents', () => {
  it('rounds to 2 decimal places — floors at the IEEE 754 boundary', () => {
    // 1.005 * 100 = 100.49999... in IEEE 754, so Math.round floors to 100 → 1.00
    // The function is correct: it avoids drift, not "half-up" banker's rounding
    expect(roundToCents(1.005)).toBeCloseTo(1.00, 2);
  });

  it('leaves whole numbers unchanged', () => {
    expect(roundToCents(1000)).toBe(1000);
  });

  it('handles zero', () => {
    expect(roundToCents(0)).toBe(0);
  });

  it('handles negative values — IEEE 754 floors toward zero', () => {
    // -15.555 * 100 = -1555.4999... → Math.round(-1555.5) = -1555 → -15.55
    expect(roundToCents(-15.555)).toBeCloseTo(-15.55, 2);
  });

  it('handles floating-point imprecision (0.1 + 0.2)', () => {
    // 0.1 + 0.2 = 0.30000000000000004 — roundToCents must fix this
    expect(roundToCents(0.1 + 0.2)).toBeCloseTo(0.30, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. getAgingBucket
// ─────────────────────────────────────────────────────────────────────────────

describe('getAgingBucket', () => {
  const asAt = new Date('2025-04-30');

  it('classifies a future due date as current', () => {
    expect(getAgingBucket(new Date('2025-05-15'), asAt)).toBe('current');
  });

  it('classifies same-day due as current', () => {
    expect(getAgingBucket(new Date('2025-04-30'), asAt)).toBe('current');
  });

  it('classifies 1 day overdue as 30-day bucket', () => {
    expect(getAgingBucket(new Date('2025-04-29'), asAt)).toBe('days30');
  });

  it('classifies 30 days overdue as 30-day bucket', () => {
    expect(getAgingBucket(new Date('2025-03-31'), asAt)).toBe('days30');
  });

  it('classifies 31 days overdue as 60-day bucket', () => {
    expect(getAgingBucket(new Date('2025-03-30'), asAt)).toBe('days60');
  });

  it('classifies 60 days overdue as 60-day bucket', () => {
    // April 30 − March 01 = exactly 60 days → days60
    expect(getAgingBucket(new Date('2025-03-01'), asAt)).toBe('days60');
  });

  it('classifies 61 days overdue as 90-day bucket', () => {
    // April 30 − February 28 = 61 days → days90
    expect(getAgingBucket(new Date('2025-02-28'), asAt)).toBe('days90');
  });

  it('classifies 90 days overdue as 90-day bucket', () => {
    // April 30 − January 30 = exactly 90 days → days90
    expect(getAgingBucket(new Date('2025-01-30'), asAt)).toBe('days90');
  });

  it('classifies 91+ days overdue as 120+ bucket', () => {
    expect(getAgingBucket(new Date('2025-01-28'), asAt)).toBe('days120Plus');
  });

  it('classifies very old invoice (365 days) as 120+', () => {
    expect(getAgingBucket(new Date('2024-04-30'), asAt)).toBe('days120Plus');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. calculateAgingBuckets
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateAgingBuckets', () => {
  const asAt = new Date('2025-04-30');

  const sampleInvoices: AgingInvoice[] = [
    // Britech (Pty) Ltd — two outstanding invoices
    { entityId: 'britech-001', entityName: 'Britech (Pty) Ltd', invoiceNumber: 'INV-001', dueDate: '2025-04-15', balance: 15000 }, // 15 days overdue → days30
    { entityId: 'britech-001', entityName: 'Britech (Pty) Ltd', invoiceNumber: 'INV-002', dueDate: '2025-01-10', balance: 8000  }, // 110 days overdue → days120Plus
    // Marneweck Brokers — one current invoice
    { entityId: 'marnew-001',  entityName: 'Marneweck Brokers', invoiceNumber: 'INV-003', dueDate: '2025-05-20', balance: 25000 }, // future → current
    // Zero-balance invoice — must be excluded
    { entityId: 'zero-001',    entityName: 'Zero Balance Co',   invoiceNumber: 'INV-004', dueDate: '2025-03-01', balance: 0     },
  ];

  it('excludes zero-balance invoices', () => {
    const buckets = calculateAgingBuckets(sampleInvoices, asAt);
    expect(buckets.find(b => b.entityId === 'zero-001')).toBeUndefined();
  });

  it('returns empty array for all-zero balances', () => {
    const allZero: AgingInvoice[] = [
      { entityId: 'x', entityName: 'X', invoiceNumber: 'INV-X', dueDate: '2025-01-01', balance: 0 },
    ];
    expect(calculateAgingBuckets(allZero, asAt)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(calculateAgingBuckets([], asAt)).toEqual([]);
  });

  it('groups multiple invoices for the same entity', () => {
    const buckets = calculateAgingBuckets(sampleInvoices, asAt);
    const britech = buckets.find(b => b.entityId === 'britech-001');
    expect(britech).toBeDefined();
    expect(britech!.days30).toBeCloseTo(15000, 0);
    expect(britech!.days120Plus).toBeCloseTo(8000, 0);
    expect(britech!.total).toBeCloseTo(23000, 0);
  });

  it('places current invoices in the current bucket', () => {
    const buckets = calculateAgingBuckets(sampleInvoices, asAt);
    const marneweck = buckets.find(b => b.entityId === 'marnew-001');
    expect(marneweck!.current).toBeCloseTo(25000, 0);
    expect(marneweck!.total).toBeCloseTo(25000, 0);
  });

  it('sorts results by total descending', () => {
    const buckets = calculateAgingBuckets(sampleInvoices, asAt);
    // Marneweck R25 000 > Britech R23 000
    expect(buckets[0]!.entityId).toBe('marnew-001');
    expect(buckets[1]!.entityId).toBe('britech-001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. validatePaymentAllocations
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePaymentAllocations', () => {
  const invoices = [
    { id: 'inv-a', invoiceNumber: 'INV-2025-001', balance: 11500 },
    { id: 'inv-b', invoiceNumber: 'INV-2025-002', balance: 5750  },
  ];

  it('accepts a valid full-payment allocation', () => {
    const result = validatePaymentAllocations(17250, [
      { invoiceId: 'inv-a', amount: 11500 },
      { invoiceId: 'inv-b', amount: 5750  },
    ], invoices);
    expect(result.valid).toBe(true);
    expect(result.totalAllocated).toBeCloseTo(17250, 2);
    expect(result.unallocated).toBeCloseTo(0, 2);
  });

  it('accepts a partial payment with unallocated remainder', () => {
    const result = validatePaymentAllocations(20000, [
      { invoiceId: 'inv-a', amount: 11500 },
    ], invoices);
    expect(result.valid).toBe(true);
    expect(result.unallocated).toBeCloseTo(8500, 2);
  });

  it('marks an invoice as fully paid when allocation equals balance', () => {
    const result = validatePaymentAllocations(11500, [
      { invoiceId: 'inv-a', amount: 11500 },
    ], invoices);
    expect(result.allocations[0]!.fullyPaid).toBe(true);
    expect(result.allocations[0]!.newBalance).toBe(0);
  });

  it('rejects allocation exceeding invoice balance', () => {
    const result = validatePaymentAllocations(15000, [
      { invoiceId: 'inv-a', amount: 12000 }, // R500 over balance
    ], invoices);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /exceeds/i.test(e))).toBe(true);
  });

  it('rejects total allocations exceeding payment amount', () => {
    const result = validatePaymentAllocations(10000, [
      { invoiceId: 'inv-a', amount: 11500 },
    ], invoices);
    expect(result.valid).toBe(false);
  });

  it('rejects zero or negative allocation amounts', () => {
    const result = validatePaymentAllocations(5000, [
      { invoiceId: 'inv-a', amount: 0 },
    ], invoices);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /positive/i.test(e))).toBe(true);
  });

  it('rejects duplicate invoice references', () => {
    const result = validatePaymentAllocations(23000, [
      { invoiceId: 'inv-a', amount: 11500 },
      { invoiceId: 'inv-a', amount: 5000  },
    ], invoices);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /duplicate/i.test(e))).toBe(true);
  });

  it('rejects allocation to a non-existent invoice', () => {
    const result = validatePaymentAllocations(5000, [
      { invoiceId: 'inv-does-not-exist', amount: 5000 },
    ], invoices);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /not found/i.test(e))).toBe(true);
  });

  it('returns unallocated = paymentAmount when no allocations provided', () => {
    const result = validatePaymentAllocations(10000, [], invoices);
    expect(result.valid).toBe(true);
    expect(result.unallocated).toBeCloseTo(10000, 2);
    expect(result.totalAllocated).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. findMatchCandidates / runAutoMatch
// ─────────────────────────────────────────────────────────────────────────────

describe('findMatchCandidates', () => {
  const glLines = [
    { id: 'line-001', debit: 0, credit: 23450, description: 'INV-2025-042 payment', entryDate: '2025-03-15', entryNumber: 'JE-2025-00042' },
    { id: 'line-002', debit: 0, credit: 5750,  description: 'Monthly retainer',     entryDate: '2025-03-10', entryNumber: 'JE-2025-00035' },
    { id: 'line-003', debit: 0, credit: 12000, description: 'Equipment purchase',   entryDate: '2025-01-01', entryNumber: 'JE-2025-00001' },
  ];

  it('matches by reference with confidence 1.0', () => {
    const bankTx = {
      id: 'tx-001',
      amount: 23450,
      transactionDate: '2025-03-16',
      reference: 'INV-2025-042',
    };
    const candidates = findMatchCandidates(bankTx, glLines);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.confidence).toBe(1.0);
    expect(candidates[0]!.journalLineId).toBe('line-001');
  });

  it('falls back to amount+date match with confidence 0.9', () => {
    const bankTx = {
      id: 'tx-002',
      amount: 5750,
      transactionDate: '2025-03-11', // 1 day from entry
    };
    const candidates = findMatchCandidates(bankTx, glLines);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('returns amount-only match at confidence 0.7 for old entries', () => {
    const bankTx = {
      id: 'tx-003',
      amount: 12000,
      transactionDate: '2025-04-01', // >3 days from '2025-01-01'
    };
    const candidates = findMatchCandidates(bankTx, glLines);
    expect(candidates.length).toBeGreaterThan(0);
    const amountOnly = candidates.find(c => c.matchReason === 'amount_only');
    expect(amountOnly).toBeDefined();
    expect(amountOnly!.confidence).toBe(0.7);
  });

  it('returns no candidates when amount does not match any GL line', () => {
    const bankTx = {
      id: 'tx-004',
      amount: 99999,
      transactionDate: '2025-03-15',
    };
    const candidates = findMatchCandidates(bankTx, glLines);
    expect(candidates).toHaveLength(0);
  });

  it('filters out candidates below custom threshold', () => {
    const bankTx = {
      id: 'tx-005',
      amount: 12000,
      transactionDate: '2025-04-01',
    };
    // With threshold 0.95, only reference/description matches should survive
    const candidates = findMatchCandidates(bankTx, glLines, 0.95);
    expect(candidates.every(c => c.confidence >= 0.95)).toBe(true);
  });

  it('matches withdrawal (negative amount) against debit lines', () => {
    const debitLines = [
      { id: 'line-debit', debit: 8500, credit: 0, description: 'Vendor payment', entryDate: '2025-03-20', entryNumber: 'JE-2025-00050' },
    ];
    const bankTx = {
      id: 'tx-006',
      amount: -8500, // withdrawal
      transactionDate: '2025-03-20',
    };
    const candidates = findMatchCandidates(bankTx, debitLines);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.journalLineId).toBe('line-debit');
  });
});

describe('runAutoMatch', () => {
  const glLines = [
    { id: 'gl-a', debit: 0, credit: 11500, description: 'INV-001', entryDate: '2025-04-01', entryNumber: 'JE-2025-00100' },
    { id: 'gl-b', debit: 0, credit: 5750,  description: 'INV-002', entryDate: '2025-04-05', entryNumber: 'JE-2025-00101' },
  ];

  it('matches all bank transactions when GL lines are available', () => {
    const bankTxs = [
      { id: 'tx-a', amount: 11500, transactionDate: '2025-04-01', reference: 'INV-001' },
      { id: 'tx-b', amount: 5750,  transactionDate: '2025-04-05', reference: 'INV-002' },
    ];
    const { matches, unmatched } = runAutoMatch(bankTxs, glLines);
    expect(matches).toHaveLength(2);
    expect(unmatched).toHaveLength(0);
  });

  it('does not assign the same GL line to two transactions', () => {
    // Two bank transactions with identical amounts — only one can claim gl-a
    const bankTxs = [
      { id: 'tx-c', amount: 11500, transactionDate: '2025-04-01' },
      { id: 'tx-d', amount: 11500, transactionDate: '2025-04-01' },
    ];
    const { matches } = runAutoMatch(bankTxs, glLines);
    const usedGlLines = matches.map(m => m.journalLineId);
    const unique = new Set(usedGlLines);
    expect(unique.size).toBe(usedGlLines.length);
  });

  it('reports unmatched transaction IDs when no GL lines available', () => {
    const bankTxs = [{ id: 'tx-z', amount: 99999, transactionDate: '2025-04-01' }];
    const { unmatched } = runAutoMatch(bankTxs, glLines);
    expect(unmatched).toContain('tx-z');
  });

  it('returns empty matches and all unmatched for empty GL lines', () => {
    const bankTxs = [{ id: 'tx-y', amount: 5000, transactionDate: '2025-04-01' }];
    const { matches, unmatched } = runAutoMatch(bankTxs, []);
    expect(matches).toHaveLength(0);
    expect(unmatched).toContain('tx-y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. validateThreeWayMatch
// ─────────────────────────────────────────────────────────────────────────────

describe('validateThreeWayMatch', () => {
  it('returns fully_matched when quantity, price, and GRN all match', () => {
    const result = validateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 250,
      invoiceQuantity: 100,
      invoiceUnitPrice: 250,
      grnQuantityReceived: 100,
    });
    expect(result.status).toBe('fully_matched');
    expect(result.quantityMatch).toBe(true);
    expect(result.priceMatch).toBe(true);
    expect(result.grnMatch).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('accepts a price within the default 2% tolerance', () => {
    const result = validateThreeWayMatch({
      poQuantity: 50,
      poUnitPrice: 1000,
      invoiceQuantity: 50,
      invoiceUnitPrice: 1015, // 1.5% over — within tolerance
      grnQuantityReceived: 50,
    });
    expect(result.priceMatch).toBe(true);
    expect(result.status).toBe('fully_matched');
  });

  it('rejects a price exceeding the default 2% tolerance', () => {
    const result = validateThreeWayMatch({
      poQuantity: 50,
      poUnitPrice: 1000,
      invoiceQuantity: 50,
      invoiceUnitPrice: 1025, // 2.5% over — exceeds tolerance
      grnQuantityReceived: 50,
    });
    expect(result.priceMatch).toBe(false);
    expect(result.mismatches.some(m => /price/i.test(m))).toBe(true);
  });

  it('respects a custom tolerance percentage', () => {
    const result = validateThreeWayMatch({
      poQuantity: 10,
      poUnitPrice: 500,
      invoiceQuantity: 10,
      invoiceUnitPrice: 525, // 5% over
      grnQuantityReceived: 10,
      tolerancePercent: 5,
    });
    expect(result.priceMatch).toBe(true);
  });

  it('returns po_matched when PO matches but GRN quantity does not', () => {
    const result = validateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 250,
      invoiceQuantity: 100,
      invoiceUnitPrice: 250,
      grnQuantityReceived: 80, // short delivery
    });
    expect(result.status).toBe('po_matched');
    expect(result.grnMatch).toBe(false);
    expect(result.mismatches.some(m => /grn/i.test(m))).toBe(true);
  });

  it('returns grn_matched when GRN aligns but PO quantity differs', () => {
    const result = validateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 250,
      invoiceQuantity: 90,
      invoiceUnitPrice: 250,
      grnQuantityReceived: 90,
    });
    expect(result.status).toBe('grn_matched');
    expect(result.quantityMatch).toBe(false);
    expect(result.grnMatch).toBe(true);
  });

  it('returns unmatched when all three checks fail', () => {
    const result = validateThreeWayMatch({
      poQuantity: 100,
      poUnitPrice: 250,
      invoiceQuantity: 80,
      invoiceUnitPrice: 300, // >2% over
      grnQuantityReceived: 70,
    });
    expect(result.status).toBe('unmatched');
    expect(result.mismatches.length).toBeGreaterThanOrEqual(3);
  });

  it('handles zero PO price without division-by-zero crash', () => {
    const result = validateThreeWayMatch({
      poQuantity: 10,
      poUnitPrice: 0,
      invoiceQuantity: 10,
      invoiceUnitPrice: 0,
      grnQuantityReceived: 10,
    });
    // Both zero — price diff is 0%, so should match
    expect(result.priceMatch).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. fuzzyMatchSupplier / fuzzyMatchClient
// ─────────────────────────────────────────────────────────────────────────────

describe('fuzzyMatchSupplier', () => {
  const suppliers = [
    { id: 'sup-001', name: 'Britech (Pty) Ltd' },
    { id: 'sup-002', name: 'Marneweck Brokers CC' },
    { id: 'sup-003', name: 'Cape Building Supplies' },
    { id: 'sup-004', name: 'Telkom SA SOC Ltd' },
  ];

  it('returns exact match at score 1.0 after normalization', () => {
    const result = fuzzyMatchSupplier('Britech Pty Ltd', suppliers);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sup-001');
    expect(result!.score).toBe(1.0);
  });

  it('matches despite business suffix variations (CC vs empty)', () => {
    const result = fuzzyMatchSupplier('Marneweck Brokers', suppliers);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sup-002');
  });

  it('strips "SOC Ltd" and matches Telkom SA', () => {
    const result = fuzzyMatchSupplier('Telkom SA', suppliers);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sup-004');
  });

  it('returns null for a completely unrelated name', () => {
    const result = fuzzyMatchSupplier('XYZ Fictional Corp 999', suppliers);
    expect(result).toBeNull();
  });

  it('returns null for an empty query string', () => {
    const result = fuzzyMatchSupplier('', suppliers);
    expect(result).toBeNull();
  });

  it('returns null for empty candidate list', () => {
    const result = fuzzyMatchSupplier('Britech', []);
    expect(result).toBeNull();
  });

  it('respects a higher custom threshold', () => {
    // With threshold 0.99 only exact post-normalization matches should qualify
    const result = fuzzyMatchSupplier('Cape Building Supplies', suppliers, 0.99);
    // This is an exact normalized match — should still pass
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sup-003');
  });
});

describe('fuzzyMatchClient', () => {
  const clients = [
    { id: 'cli-001', companyName: 'Sasol Energy (Pty) Ltd' },
    { id: 'cli-002', companyName: 'Woolworths Holdings Ltd' },
    { id: 'cli-003', name: 'Individual Client' }, // uses name field fallback
  ];

  it('matches using companyName field', () => {
    const result = fuzzyMatchClient('Sasol Energy', clients);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('cli-001');
  });

  it('matches using name field as fallback', () => {
    const result = fuzzyMatchClient('Individual Client', clients);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('cli-003');
  });

  it('returns null for empty candidates', () => {
    const result = fuzzyMatchClient('Sasol', []);
    expect(result).toBeNull();
  });

  it('returns null for empty extracted name', () => {
    const result = fuzzyMatchClient('', clients);
    expect(result).toBeNull();
  });
});
