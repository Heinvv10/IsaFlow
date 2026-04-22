/**
 * Unit tests for the supplier-statement reconciliation match helpers.
 *
 * The orchestrator (supplierStatementReconService) composes a VLM call with
 * a multi-layer DB write. That composition is best exercised via an
 * integration test; here we lock down the pure match logic that drives the
 * "what does each statement line get classified as" behaviour — the piece
 * the Phase 7 exit criterion ("match 90%+ of lines") actually depends on.
 */

import { describe, it, expect } from 'vitest';
import {
  matchLine,
  buildMissingInvoices,
  type InvoiceRecord,
} from '@/modules/accounting/services/capture/supplierStatementMatchHelper';

const INVOICE_A: InvoiceRecord = {
  id: 'inv-a', invoiceNumber: 'INV-001', invoiceDate: '2026-03-15', totalAmount: 1000,
};
const INVOICE_B: InvoiceRecord = {
  id: 'inv-b', invoiceNumber: 'INV-002', invoiceDate: '2026-03-20', totalAmount: 2500.50,
};

describe('matchLine — reference path', () => {
  it('returns confidence 1.0 + null mismatch when ref + amount + date all match', () => {
    const result = matchLine('INV-001', 1000, '2026-03-15', [INVOICE_A]);
    expect(result).toEqual({ invoiceId: 'inv-a', confidence: 1.0, mismatchReason: null });
  });

  it('is case-insensitive on reference', () => {
    const result = matchLine('inv-001', 1000, '2026-03-15', [INVOICE_A]);
    expect(result.invoiceId).toBe('inv-a');
    expect(result.confidence).toBe(1.0);
  });

  it('flags amount_diff when ref matches but totals differ by > R0.01', () => {
    const result = matchLine('INV-001', 1005, '2026-03-15', [INVOICE_A]);
    expect(result).toEqual({ invoiceId: 'inv-a', confidence: 1.0, mismatchReason: 'amount_diff' });
  });

  it('does not flag amount_diff within R0.01 tolerance', () => {
    const result = matchLine('INV-001', 1000.005, '2026-03-15', [INVOICE_A]);
    expect(result.mismatchReason).toBeNull();
  });

  it('flags date_diff when ref matches but dates differ > 7 days', () => {
    const result = matchLine('INV-001', 1000, '2026-03-23', [INVOICE_A]);
    expect(result).toEqual({ invoiceId: 'inv-a', confidence: 1.0, mismatchReason: 'date_diff' });
  });

  it('prefers amount_diff over date_diff when both fail', () => {
    const result = matchLine('INV-001', 1050, '2026-03-25', [INVOICE_A]);
    expect(result.mismatchReason).toBe('amount_diff');
  });
});

describe('matchLine — fuzzy path', () => {
  it('matches within ±0.5% amount + ±3d date → confidence 0.85', () => {
    // 1004 is 0.4% of 1000 — inside the ±0.5% window. Date 2026-03-16 is 1d off.
    const result = matchLine(undefined, 1004, '2026-03-16', [INVOICE_A]);
    expect(result.invoiceId).toBe('inv-a');
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.mismatchReason).toBe('amount_diff'); // R4 diff > R0.01 threshold
  });

  it('matches within R0.01 amount tolerance without triggering amount_diff', () => {
    const result = matchLine(undefined, 1000.005, '2026-03-16', [INVOICE_A]);
    expect(result.invoiceId).toBe('inv-a');
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.mismatchReason).toBeNull();
  });

  it('returns missing_in_isaflow when amount is outside fuzzy window', () => {
    const result = matchLine(undefined, 1500, '2026-03-16', [INVOICE_A]);
    expect(result).toEqual({ invoiceId: null, confidence: null, mismatchReason: 'missing_in_isaflow' });
  });

  it('returns missing_in_isaflow when date is outside ±3d window', () => {
    const result = matchLine(undefined, 1000, '2026-03-25', [INVOICE_A]);
    expect(result.mismatchReason).toBe('missing_in_isaflow');
  });

  it('ignores zero-debit rows (supplier-statement payment lines)', () => {
    const result = matchLine(undefined, 0, '2026-03-16', [INVOICE_A]);
    expect(result.mismatchReason).toBe('missing_in_isaflow');
  });
});

describe('matchLine — no-match fallback', () => {
  it('returns missing_in_isaflow when invoices array is empty', () => {
    const result = matchLine('INV-001', 1000, '2026-03-15', []);
    expect(result).toEqual({ invoiceId: null, confidence: null, mismatchReason: 'missing_in_isaflow' });
  });

  it('returns missing_in_isaflow when ref does not match any invoice', () => {
    const result = matchLine('UNKNOWN-999', 9999, '2026-03-15', [INVOICE_A, INVOICE_B]);
    expect(result.mismatchReason).toBe('missing_in_isaflow');
  });

  it('picks the correct invoice when multiple exist', () => {
    const result = matchLine(undefined, 2500, '2026-03-20', [INVOICE_A, INVOICE_B]);
    expect(result.invoiceId).toBe('inv-b');
    expect(result.confidence).toBeCloseTo(0.85);
  });
});

describe('buildMissingInvoices', () => {
  it('returns every invoice not in the matched set', () => {
    const result = buildMissingInvoices([INVOICE_A, INVOICE_B], new Set(['inv-a']));
    expect(result).toHaveLength(1);
    expect(result[0]!.invoiceId).toBe('inv-b');
  });

  it('returns empty array when every invoice is matched', () => {
    const result = buildMissingInvoices([INVOICE_A], new Set(['inv-a']));
    expect(result).toEqual([]);
  });

  it('returns every invoice when matched set is empty', () => {
    const result = buildMissingInvoices([INVOICE_A, INVOICE_B], new Set());
    expect(result).toHaveLength(2);
  });

  it('preserves invoice shape: id, number, date, amount', () => {
    const result = buildMissingInvoices([INVOICE_A], new Set());
    expect(result[0]).toEqual({
      invoiceId: 'inv-a', invoiceNumber: 'INV-001', invoiceDate: '2026-03-15', totalAmount: 1000,
    });
  });
});
