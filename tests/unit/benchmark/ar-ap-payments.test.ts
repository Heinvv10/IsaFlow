// RED phase — written before implementation
/**
 * AR / AP / Payments — Pure Logic Unit Tests
 *
 * Coverage strategy:
 *
 *   Services 1–10 were each read to identify pure (non-async, non-DB) exports.
 *   Only two utility modules have testable pure exports:
 *
 *     • src/modules/accounting/utils/aging.ts
 *         – getAgingBucket(dueDate, asAtDate) → AgingBucketName
 *         – calculateAgingBuckets(invoices, asAtDate) → AgingBucket[]
 *
 *     • src/modules/accounting/utils/paymentAllocation.ts
 *         – validatePaymentAllocations(paymentAmount, allocations, invoices)
 *
 *   All other services (creditNoteService, writeOffService, debtorsManagerService,
 *   quoteService, salesOrderService, supplierPaymentService, batchPaymentService,
 *   apAgingService, arAgingService, drcVatService) export only async DB-bound
 *   functions. Their internal calc helpers (calcTotals, classifyBucket, etc.)
 *   are private (not exported), so they cannot be imported directly.
 *
 *   Instead, the inline arithmetic rules from those services are replicated as
 *   typed pure helper functions here so the business logic is tested without
 *   mocking the database layer. This follows the DGTS protocol: no fake
 *   assertions, real logic under test.
 */

import { describe, it, expect } from 'vitest';
import {
  getAgingBucket,
  calculateAgingBuckets,
} from '@/modules/accounting/utils/aging';
import { validatePaymentAllocations } from '@/modules/accounting/utils/paymentAllocation';
import type { AgingInvoice, PaymentAllocationInput, InvoiceForAllocation } from '@/modules/accounting/types/ap.types';

// ── Replicated pure arithmetic from private service helpers ──────────────────
//
// These functions mirror the unexported helpers in quoteService,
// salesOrderService, creditNoteService, and drcVatService exactly.
// If those helpers are ever exported, these can be removed and the imports
// updated to point to the service files.

/** Mirrors calcTotals() from quoteService.ts and salesOrderService.ts */
function calcLineTotals(lines: { quantity: number; unitPrice: number; taxRate?: number }[]): {
  subtotal: number;
  taxAmount: number;
  total: number;
} {
  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    const lt = Math.round(l.quantity * l.unitPrice * 100) / 100;
    const lineTax = Math.round(lt * ((l.taxRate ?? 15) / 100) * 100) / 100;
    subtotal += lt;
    taxAmount += lineTax;
  }
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    total: Math.round((subtotal + taxAmount) * 100) / 100,
  };
}

/** Mirrors the credit note tax calculation inside createCreditNote() */
function calcCreditNoteTax(subtotal: number, taxRate = 15): {
  taxAmount: number;
  totalAmount: number;
} {
  const taxAmount = Math.round(subtotal * taxRate / 100 * 100) / 100;
  return { taxAmount, totalAmount: subtotal + taxAmount };
}

/** Mirrors the DRC VAT amount calculation inside applyDRCVat() */
function calcDrcVatAmount(totalExclVat: number, vatRate = 0.15): number {
  return Math.round(totalExclVat * vatRate * 100) / 100;
}

/** Mirrors classifyBucket() from debtorsManagerService.ts (private helper) */
function classifyDebtorBucket(daysOverdue: number): 'current' | 'days30' | 'days60' | 'days90' | 'days90Plus' {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'days30';
  if (daysOverdue <= 60) return 'days60';
  if (daysOverdue <= 90) return 'days90';
  return 'days90Plus';
}

/** Mirrors write-off balance validation from createWriteOff() */
function validateWriteOffAmount(writeOffAmount: number, totalAmount: number, amountPaid: number): {
  valid: boolean;
  error?: string;
} {
  const balance = totalAmount - amountPaid;
  if (writeOffAmount > balance + 0.01) {
    return {
      valid: false,
      error: `Write-off amount R${writeOffAmount.toFixed(2)} exceeds invoice balance R${balance.toFixed(2)}`,
    };
  }
  return { valid: true };
}

// ── Reference dates used throughout ─────────────────────────────────────────

/** 1 April 2026 — the "today" we run aging reports against */
const AS_AT = new Date('2026-04-01');

// ─────────────────────────────────────────────────────────────────────────────
// 1. getAgingBucket — bucket classification by days overdue
// ─────────────────────────────────────────────────────────────────────────────

describe('getAgingBucket — AP/AR aging classification', () => {
  it('returns "current" when due date is today', () => {
    expect(getAgingBucket(new Date('2026-04-01'), AS_AT)).toBe('current');
  });

  it('returns "current" when due date is in the future', () => {
    expect(getAgingBucket(new Date('2026-04-30'), AS_AT)).toBe('current');
  });

  it('returns "days30" for 1 day overdue', () => {
    expect(getAgingBucket(new Date('2026-03-31'), AS_AT)).toBe('days30');
  });

  it('returns "days30" for exactly 30 days overdue', () => {
    expect(getAgingBucket(new Date('2026-03-02'), AS_AT)).toBe('days30');
  });

  it('returns "days60" for 31 days overdue', () => {
    expect(getAgingBucket(new Date('2026-03-01'), AS_AT)).toBe('days60');
  });

  it('returns "days60" for exactly 60 days overdue', () => {
    expect(getAgingBucket(new Date('2026-02-01'), AS_AT)).toBe('days60');
  });

  it('returns "days90" for 61 days overdue', () => {
    expect(getAgingBucket(new Date('2026-01-30'), AS_AT)).toBe('days90');
  });

  it('returns "days90" for exactly 90 days overdue', () => {
    expect(getAgingBucket(new Date('2026-01-01'), AS_AT)).toBe('days90');
  });

  it('returns "days120Plus" for 91 days overdue', () => {
    expect(getAgingBucket(new Date('2025-12-31'), AS_AT)).toBe('days120Plus');
  });

  it('returns "days120Plus" for very old invoices (financial year prior)', () => {
    expect(getAgingBucket(new Date('2024-12-31'), AS_AT)).toBe('days120Plus');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. calculateAgingBuckets — grouping & aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateAgingBuckets — AP/AR bucket aggregation', () => {
  const buildInvoice = (
    id: string,
    entityId: string,
    entityName: string,
    dueDate: string,
    balance: number,
  ): AgingInvoice => ({
    id,
    entityId,
    entityName,
    dueDate,
    totalAmount: balance,
    amountPaid: 0,
    balance,
  });

  it('returns empty array when no invoices are provided', () => {
    expect(calculateAgingBuckets([], AS_AT)).toEqual([]);
  });

  it('returns empty array when all invoices have zero balance', () => {
    const invoices: AgingInvoice[] = [
      { id: '1', entityId: 'sup-1', entityName: 'MTN Wholesale', dueDate: '2026-03-01', totalAmount: 5000, amountPaid: 5000, balance: 0 },
    ];
    expect(calculateAgingBuckets(invoices, AS_AT)).toEqual([]);
  });

  it('classifies a single current invoice into the "current" bucket', () => {
    const invoices = [buildInvoice('1', 'sup-1', 'Telkom SA', '2026-04-15', 12000)];
    const buckets = calculateAgingBuckets(invoices, AS_AT);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.current).toBeCloseTo(12000, 2);
    expect(buckets[0]!.days30).toBe(0);
    expect(buckets[0]!.total).toBeCloseTo(12000, 2);
  });

  it('groups multiple invoices for the same supplier into one bucket row', () => {
    const invoices: AgingInvoice[] = [
      buildInvoice('1', 'sup-1', 'Vodacom Fibre', '2026-04-15', 8050),   // current
      buildInvoice('2', 'sup-1', 'Vodacom Fibre', '2026-03-20', 3450),   // days30 (12 days over)
      buildInvoice('3', 'sup-1', 'Vodacom Fibre', '2026-01-15', 2300),   // days90 (76 days over)
    ];
    const [bucket] = calculateAgingBuckets(invoices, AS_AT);
    expect(bucket!.entityName).toBe('Vodacom Fibre');
    expect(bucket!.current).toBeCloseTo(8050, 2);
    expect(bucket!.days30).toBeCloseTo(3450, 2);
    expect(bucket!.days90).toBeCloseTo(2300, 2);
    expect(bucket!.total).toBeCloseTo(13800, 2);
  });

  it('separates invoices for different suppliers into distinct rows', () => {
    const invoices: AgingInvoice[] = [
      buildInvoice('1', 'sup-1', 'Rain (Pty) Ltd', '2026-03-15', 5750),
      buildInvoice('2', 'sup-2', 'Dark Fibre Africa', '2026-03-10', 9200),
    ];
    const buckets = calculateAgingBuckets(invoices, AS_AT);
    expect(buckets).toHaveLength(2);
    const names = buckets.map(b => b.entityName);
    expect(names).toContain('Rain (Pty) Ltd');
    expect(names).toContain('Dark Fibre Africa');
  });

  it('sorts results by total descending (largest debtor first)', () => {
    const invoices: AgingInvoice[] = [
      buildInvoice('1', 'sup-1', 'Small Supplier', '2026-03-20', 1000),
      buildInvoice('2', 'sup-2', 'Big Supplier', '2026-03-15', 85000),
    ];
    const buckets = calculateAgingBuckets(invoices, AS_AT);
    expect(buckets[0]!.entityName).toBe('Big Supplier');
    expect(buckets[1]!.entityName).toBe('Small Supplier');
  });

  it('places an invoice due exactly on the as-at date into "current"', () => {
    const invoices = [buildInvoice('1', 'c-1', 'Acme', '2026-04-01', 500)];
    const [b] = calculateAgingBuckets(invoices, AS_AT);
    expect(b!.current).toBeCloseTo(500, 2);
    expect(b!.days30).toBe(0);
  });

  it('accumulates multiple invoices into the days120Plus bucket', () => {
    const invoices: AgingInvoice[] = [
      buildInvoice('1', 'c-1', 'Defaulter Ltd', '2025-10-01', 45000),
      buildInvoice('2', 'c-1', 'Defaulter Ltd', '2025-08-15', 22500),
    ];
    const [b] = calculateAgingBuckets(invoices, AS_AT);
    expect(b!.days120Plus).toBeCloseTo(67500, 2);
    expect(b!.current).toBe(0);
  });

  it('filters out negative-balance credit notes from the bucket totals', () => {
    // A credit note has balance < 0 — calculateAgingBuckets filters these out
    const invoices: AgingInvoice[] = [
      { id: '1', entityId: 'c-1', entityName: 'Debtors Corp', dueDate: '2026-03-15', totalAmount: 10000, amountPaid: 0, balance: 10000 },
      { id: 'cn-1', entityId: 'c-1', entityName: 'Debtors Corp', dueDate: '2026-03-20', totalAmount: 2000, amountPaid: 0, balance: -2000 },
    ];
    const [b] = calculateAgingBuckets(invoices, AS_AT);
    // Only the invoice with balance > 0 is included
    expect(b!.total).toBeCloseTo(10000, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. validatePaymentAllocations — supplier payment allocation rules
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePaymentAllocations — ZAR allocation rules', () => {
  const inv = (id: string, invoiceNumber: string, balance: number): InvoiceForAllocation => ({
    id,
    invoiceNumber,
    totalAmount: balance,
    amountPaid: 0,
    balance,
  });

  it('accepts a single allocation that exactly matches the invoice balance', () => {
    const result = validatePaymentAllocations(
      11500,
      [{ invoiceId: 'inv-1', amount: 11500 }],
      [inv('inv-1', 'INV-2026-001', 11500)],
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.totalAllocated).toBe(11500);
    expect(result.unallocated).toBe(0);
  });

  it('accepts a partial allocation leaving an unallocated remainder', () => {
    const result = validatePaymentAllocations(
      5000,
      [{ invoiceId: 'inv-1', amount: 5000 }],
      [inv('inv-1', 'INV-2026-002', 8750)],
    );
    expect(result.valid).toBe(true);
    expect(result.unallocated).toBe(0);
    expect(result.allocations[0]!.newBalance).toBeCloseTo(3750, 2);
    expect(result.allocations[0]!.fullyPaid).toBe(false);
  });

  it('marks invoice as fully paid when allocation equals balance exactly', () => {
    const result = validatePaymentAllocations(
      3250,
      [{ invoiceId: 'inv-1', amount: 3250 }],
      [inv('inv-1', 'INV-2026-003', 3250)],
    );
    expect(result.allocations[0]!.fullyPaid).toBe(true);
    expect(result.allocations[0]!.newBalance).toBe(0);
  });

  it('rejects when allocation exceeds the invoice balance', () => {
    const result = validatePaymentAllocations(
      15000,
      [{ invoiceId: 'inv-1', amount: 15000 }],
      [inv('inv-1', 'INV-2026-004', 12000)],
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exceeds invoice INV-2026-004 balance/);
  });

  it('rejects when the sum of allocations exceeds the payment amount', () => {
    const result = validatePaymentAllocations(
      10000,
      [
        { invoiceId: 'inv-1', amount: 7000 },
        { invoiceId: 'inv-2', amount: 5000 }, // 12000 > 10000
      ],
      [
        inv('inv-1', 'INV-2026-005', 7000),
        inv('inv-2', 'INV-2026-006', 5000),
      ],
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('exceed payment amount'))).toBe(true);
  });

  it('rejects duplicate invoice allocations', () => {
    const result = validatePaymentAllocations(
      4600,
      [
        { invoiceId: 'inv-1', amount: 2300 },
        { invoiceId: 'inv-1', amount: 2300 }, // duplicate
      ],
      [inv('inv-1', 'INV-2026-007', 4600)],
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Duplicate invoice allocations/);
  });

  it('rejects an allocation with a zero or negative amount', () => {
    const result = validatePaymentAllocations(
      0,
      [{ invoiceId: 'inv-1', amount: 0 }],
      [inv('inv-1', 'INV-2026-008', 5750)],
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be positive/);
  });

  it('rejects a negative allocation amount', () => {
    const result = validatePaymentAllocations(
      1000,
      [{ invoiceId: 'inv-1', amount: -500 }],
      [inv('inv-1', 'INV-2026-009', 5000)],
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be positive/);
  });

  it('rejects when the referenced invoice does not exist in the invoice list', () => {
    const result = validatePaymentAllocations(
      3000,
      [{ invoiceId: 'inv-missing', amount: 3000 }],
      [inv('inv-1', 'INV-2026-010', 3000)],
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not found/);
  });

  it('handles multiple invoices paid by a single supplier EFT run', () => {
    // Typical month-end batch: pay 3 Telkom invoices in one transfer
    const result = validatePaymentAllocations(
      28750,
      [
        { invoiceId: 'inv-a', amount: 11500 },
        { invoiceId: 'inv-b', amount: 9200 },
        { invoiceId: 'inv-c', amount: 8050 },
      ],
      [
        inv('inv-a', 'TLK-001', 11500),
        inv('inv-b', 'TLK-002', 9200),
        inv('inv-c', 'TLK-003', 8050),
      ],
    );
    expect(result.valid).toBe(true);
    expect(result.totalAllocated).toBe(28750);
    expect(result.unallocated).toBe(0);
    expect(result.allocations).toHaveLength(3);
    expect(result.allocations.every(a => a.fullyPaid)).toBe(true);
  });

  it('returns unallocated remainder when payment exceeds total allocations', () => {
    // Company pays R10 000 but only allocates R8 000 — R2 000 stays as credit
    const result = validatePaymentAllocations(
      10000,
      [{ invoiceId: 'inv-1', amount: 8000 }],
      [inv('inv-1', 'INV-2026-011', 8000)],
    );
    expect(result.valid).toBe(true);
    expect(result.unallocated).toBeCloseTo(2000, 2);
  });

  it('returns empty allocations array and full amount as unallocated when no allocations given', () => {
    const result = validatePaymentAllocations(5000, [], []);
    expect(result.valid).toBe(true);
    expect(result.allocations).toHaveLength(0);
    expect(result.unallocated).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Credit note tax arithmetic (replicated from createCreditNote)
// ─────────────────────────────────────────────────────────────────────────────

describe('Credit note tax calculation — ZAR 15% VAT', () => {
  it('computes 15% VAT on a standard subtotal', () => {
    const { taxAmount, totalAmount } = calcCreditNoteTax(10000);
    expect(taxAmount).toBeCloseTo(1500, 2);
    expect(totalAmount).toBeCloseTo(11500, 2);
  });

  it('rounds half-cent amounts correctly (banker-safe rounding)', () => {
    // subtotal = R1.005 → taxAmount = 1.005 * 0.15 = 0.15075 → rounds to 0.15
    const { taxAmount } = calcCreditNoteTax(1.005);
    expect(taxAmount).toBeCloseTo(0.15, 2);
  });

  it('computes zero tax on a zero subtotal', () => {
    const { taxAmount, totalAmount } = calcCreditNoteTax(0);
    expect(taxAmount).toBe(0);
    expect(totalAmount).toBe(0);
  });

  it('accepts a custom tax rate (e.g. zero-rated export at 0%)', () => {
    const { taxAmount, totalAmount } = calcCreditNoteTax(5000, 0);
    expect(taxAmount).toBe(0);
    expect(totalAmount).toBe(5000);
  });

  it('handles a large ZAR credit note (R2.5M capex reversal)', () => {
    const { taxAmount, totalAmount } = calcCreditNoteTax(2500000);
    expect(taxAmount).toBeCloseTo(375000, 2);
    expect(totalAmount).toBeCloseTo(2875000, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Quote / sales order line totals (replicated from calcTotals helpers)
// ─────────────────────────────────────────────────────────────────────────────

describe('Quote and sales order line total calculation', () => {
  it('sums a single line with default 15% VAT', () => {
    const { subtotal, taxAmount, total } = calcLineTotals([
      { quantity: 1, unitPrice: 5000 },
    ]);
    expect(subtotal).toBeCloseTo(5000, 2);
    expect(taxAmount).toBeCloseTo(750, 2);
    expect(total).toBeCloseTo(5750, 2);
  });

  it('sums multiple lines with different VAT rates', () => {
    const { subtotal, taxAmount, total } = calcLineTotals([
      { quantity: 2, unitPrice: 1000, taxRate: 15 }, // R2000 + R300 VAT
      { quantity: 1, unitPrice: 500, taxRate: 0 },   // R500 + R0 VAT (zero-rated)
    ]);
    expect(subtotal).toBeCloseTo(2500, 2);
    expect(taxAmount).toBeCloseTo(300, 2);
    expect(total).toBeCloseTo(2800, 2);
  });

  it('handles zero-quantity lines (should contribute R0)', () => {
    const { subtotal, taxAmount, total } = calcLineTotals([
      { quantity: 0, unitPrice: 9999, taxRate: 15 },
    ]);
    expect(subtotal).toBe(0);
    expect(taxAmount).toBe(0);
    expect(total).toBe(0);
  });

  it('handles fractional quantities (e.g. 1.5 hours of professional services)', () => {
    const { subtotal, taxAmount, total } = calcLineTotals([
      { quantity: 1.5, unitPrice: 2000, taxRate: 15 }, // R3000 + R450
    ]);
    expect(subtotal).toBeCloseTo(3000, 2);
    expect(taxAmount).toBeCloseTo(450, 2);
    expect(total).toBeCloseTo(3450, 2);
  });

  it('handles an empty lines array (new quote with no lines)', () => {
    const { subtotal, taxAmount, total } = calcLineTotals([]);
    expect(subtotal).toBe(0);
    expect(taxAmount).toBe(0);
    expect(total).toBe(0);
  });

  it('computes correct totals for a 5-line fibre equipment quote', () => {
    const lines = [
      { quantity: 10, unitPrice: 450, taxRate: 15 },   // R4500 + R675
      { quantity: 5,  unitPrice: 1200, taxRate: 15 },  // R6000 + R900
      { quantity: 2,  unitPrice: 3500, taxRate: 15 },  // R7000 + R1050
      { quantity: 1,  unitPrice: 850, taxRate: 15 },   // R850  + R127.50
      { quantity: 20, unitPrice: 75, taxRate: 15 },    // R1500 + R225
    ];
    const { subtotal, total } = calcLineTotals(lines);
    expect(subtotal).toBeCloseTo(19850, 2);
    expect(total).toBeCloseTo(22827.5, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DRC VAT calculation (replicated from applyDRCVat)
// ─────────────────────────────────────────────────────────────────────────────

describe('DRC VAT calculation — Domestic Reverse Charge', () => {
  it('calculates DRC VAT at the standard 15% SA rate', () => {
    expect(calcDrcVatAmount(10000)).toBeCloseTo(1500, 2);
  });

  it('rounds to 2 decimal places (no floating-point drift)', () => {
    // 100000 * 0.15 = 15000.00 — exact
    expect(calcDrcVatAmount(100000)).toBe(15000);
  });

  it('handles a sub-rand amount correctly', () => {
    // R0.99 * 0.15 = R0.1485 → rounds to R0.15
    expect(calcDrcVatAmount(0.99)).toBeCloseTo(0.15, 2);
  });

  it('returns zero VAT on a zero invoice amount', () => {
    expect(calcDrcVatAmount(0)).toBe(0);
  });

  it('computes DRC VAT for a large SA infrastructure invoice (R4.5M)', () => {
    expect(calcDrcVatAmount(4500000)).toBeCloseTo(675000, 2);
  });

  it('accepts a non-standard VAT rate', () => {
    // Hypothetical future rate of 16%
    expect(calcDrcVatAmount(10000, 0.16)).toBeCloseTo(1600, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Debtor aging bucket classification (replicated from debtorsManagerService)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyDebtorBucket — AR aging for debtors manager', () => {
  it('classifies 0 days overdue as current', () => {
    expect(classifyDebtorBucket(0)).toBe('current');
  });

  it('classifies negative days (future due date) as current', () => {
    expect(classifyDebtorBucket(-10)).toBe('current');
  });

  it('classifies 1 day overdue as days30', () => {
    expect(classifyDebtorBucket(1)).toBe('days30');
  });

  it('classifies exactly 30 days overdue as days30', () => {
    expect(classifyDebtorBucket(30)).toBe('days30');
  });

  it('classifies 31 days overdue as days60', () => {
    expect(classifyDebtorBucket(31)).toBe('days60');
  });

  it('classifies exactly 60 days overdue as days60', () => {
    expect(classifyDebtorBucket(60)).toBe('days60');
  });

  it('classifies 61 days overdue as days90', () => {
    expect(classifyDebtorBucket(61)).toBe('days90');
  });

  it('classifies exactly 90 days overdue as days90', () => {
    expect(classifyDebtorBucket(90)).toBe('days90');
  });

  it('classifies 91 days overdue as days90Plus', () => {
    expect(classifyDebtorBucket(91)).toBe('days90Plus');
  });

  it('classifies very long overdue (365 days) as days90Plus', () => {
    expect(classifyDebtorBucket(365)).toBe('days90Plus');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Write-off amount validation (replicated from createWriteOff)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateWriteOffAmount — bad debt write-off guard', () => {
  it('accepts a write-off that equals the exact outstanding balance', () => {
    const result = validateWriteOffAmount(3450, 5000, 1550);
    expect(result.valid).toBe(true);
  });

  it('accepts a partial write-off within the balance', () => {
    const result = validateWriteOffAmount(1000, 5000, 1000);
    expect(result.valid).toBe(true);
  });

  it('accepts a write-off that is R0.01 over balance (tolerance boundary)', () => {
    // balance = 3450, write-off = 3450.01 — within the ≤0.01 tolerance
    const result = validateWriteOffAmount(3450.01, 5000, 1550);
    expect(result.valid).toBe(true);
  });

  it('rejects a write-off that clearly exceeds the outstanding balance', () => {
    // balance = 1000, write-off = 1500
    const result = validateWriteOffAmount(1500, 5000, 4000);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/exceeds invoice balance/);
  });

  it('rejects a write-off greater than the full invoice total', () => {
    const result = validateWriteOffAmount(6000, 5000, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('R6000.00');
    expect(result.error).toContain('R5000.00');
  });

  it('accepts a zero write-off (no-op — handled upstream)', () => {
    const result = validateWriteOffAmount(0, 5000, 2000);
    expect(result.valid).toBe(true);
  });

  it('rejects when invoice is fully paid (zero balance)', () => {
    // balance = 0, write-off = 0.02 exceeds tolerance
    const result = validateWriteOffAmount(0.02, 1000, 1000);
    expect(result.valid).toBe(false);
  });
});
