// RED phase — written before implementation
/**
 * Unit tests for fourWayMatchService.ts — recordPaymentMatch
 *
 * Covers: full payment, partial payment, cumulative full payment,
 * R0.01 ZAR tolerance, idempotency (already matched), and invoice not found.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  fmtDate: (x: unknown) => String(x),
  DbRow: null,
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordPaymentMatch } from '@/modules/accounting/services/capture/fourWayMatchService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const INVOICE_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInvoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_amount: 1000,
    amount_paid: 0,
    payment_matched: false,
    ...overrides,
  };
}

/** Returns SELECT row + UPDATE row for the full-payment path */
function setupFullPaymentCalls(
  selectRow: Record<string, unknown>,
): void {
  vi.mocked(sqlMock)
    .mockResolvedValueOnce([selectRow] as never)  // SELECT
    .mockResolvedValueOnce([] as never);           // UPDATE
}

/** Returns SELECT row only for the partial-payment path (no UPDATE) */
function setupPartialPaymentCalls(
  selectRow: Record<string, unknown>,
): void {
  vi.mocked(sqlMock)
    .mockResolvedValueOnce([selectRow] as never);  // SELECT — no UPDATE follows
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('recordPaymentMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Full amount allocated ─────────────────────────────────────────────────

  it('returns { paymentMatched: true } and fires UPDATE when full amount is allocated in one payment', async () => {
    // total R1000, amount_paid R0, allocated R1000 → projectedPaid=1000 >= 1000
    setupFullPaymentCalls(makeInvoiceRow({ total_amount: 1000, amount_paid: 0 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 1000);

    expect(result.paymentMatched).toBe(true);
    // SELECT + UPDATE = 2 sql calls
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(2);
  });

  // ── Partial payment — no match yet ────────────────────────────────────────

  it('returns { paymentMatched: false } and fires NO UPDATE when payment is partial', async () => {
    // total R1000, amount_paid R400, allocated R300 → projected=700 < 1000
    setupPartialPaymentCalls(makeInvoiceRow({ total_amount: 1000, amount_paid: 400 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 300);

    expect(result.paymentMatched).toBe(false);
    // Only SELECT, no UPDATE
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  // ── Cumulative full payment ───────────────────────────────────────────────

  it('returns { paymentMatched: true } and fires UPDATE when cumulative payments cover the total', async () => {
    // total R1000, amount_paid R700, allocated R300 → projected=1000 >= 1000
    setupFullPaymentCalls(makeInvoiceRow({ total_amount: 1000, amount_paid: 700 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 300);

    expect(result.paymentMatched).toBe(true);
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(2);
  });

  // ── ZAR R0.01 tolerance ───────────────────────────────────────────────────

  it('returns { paymentMatched: true } when projected paid is within R0.01 of total (R999.995 of R1000)', async () => {
    // projected = 0 + 999.995 = 999.995; tolerance check: 999.995 >= 1000 - 0.01 = 999.99 ✓
    setupFullPaymentCalls(makeInvoiceRow({ total_amount: 1000.00, amount_paid: 0 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 999.995);

    expect(result.paymentMatched).toBe(true);
  });

  it('returns { paymentMatched: false } when underpayment exceeds R0.01 tolerance', async () => {
    // projected = 0 + 999.98 = 999.98; 999.98 < 999.99 → NOT within tolerance
    setupPartialPaymentCalls(makeInvoiceRow({ total_amount: 1000.00, amount_paid: 0 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 999.98);

    expect(result.paymentMatched).toBe(false);
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  // ── Idempotency — already matched ─────────────────────────────────────────

  it('returns { paymentMatched: true } immediately and fires NO extra UPDATE when already matched', async () => {
    // payment_matched=true → early return, no UPDATE should fire
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeInvoiceRow({ payment_matched: true })] as never); // SELECT only

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 1000);

    expect(result.paymentMatched).toBe(true);
    // Only the SELECT call — no UPDATE
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('does not flip back to false when called again after full match (second allocation R0)', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeInvoiceRow({ payment_matched: true, total_amount: 1000, amount_paid: 1000 })] as never);

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 0);

    expect(result.paymentMatched).toBe(true);
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  // ── Invoice not found ─────────────────────────────────────────────────────

  it('returns { paymentMatched: false } when invoice is not found (wrong company_id)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await recordPaymentMatch('wrong-company', INVOICE_ID, 1000);

    expect(result.paymentMatched).toBe(false);
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles zero allocated amount without crashing', async () => {
    setupPartialPaymentCalls(makeInvoiceRow({ total_amount: 1000, amount_paid: 0 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 0);

    expect(result.paymentMatched).toBe(false);
  });

  it('returns { paymentMatched: true } when overpayment exceeds total (credit note scenario)', async () => {
    // projected = 0 + 1100 = 1100 >= 1000 - 0.01 → matched
    setupFullPaymentCalls(makeInvoiceRow({ total_amount: 1000, amount_paid: 0 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 1100);

    expect(result.paymentMatched).toBe(true);
  });
});
