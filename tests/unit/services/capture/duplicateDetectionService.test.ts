// RED phase — written before implementation
/**
 * Unit tests for duplicateDetectionService.ts
 *
 * Covers: computeFingerprint (pure function: determinism, lowercase, null fallbacks)
 * and findDuplicate (exact match at 1.0, fuzzy at 0.95 and 0.85, null when no match).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  computeFingerprint,
  findDuplicate,
  type DuplicateHit,
} from '@/modules/accounting/services/capture/duplicateDetectionService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const INVOICE_ID    = 'cccccccc-0000-0000-0000-000000000003';
const VAT_NUMBER    = '4150165685';
const INVOICE_NUM   = 'INV-2026-001';
const TOTAL_AMOUNT  = 11500;
const INVOICE_DATE  = '2026-01-15';

function makeExactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_NUM,
    total_amount: TOTAL_AMOUNT,
    invoice_date: INVOICE_DATE,
    ...overrides,
  };
}

// ── computeFingerprint ────────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('produces the expected format: vat|inv|amount in lowercase', () => {
    const fp = computeFingerprint('4150165685', 'INV-2026-001', 11500);
    expect(fp).toBe('4150165685|inv-2026-001|11500');
  });

  it('is deterministic — same inputs always produce the same output', () => {
    const a = computeFingerprint(VAT_NUMBER, INVOICE_NUM, TOTAL_AMOUNT);
    const b = computeFingerprint(VAT_NUMBER, INVOICE_NUM, TOTAL_AMOUNT);
    expect(a).toBe(b);
  });

  it('lowercases the entire fingerprint', () => {
    const fp = computeFingerprint('ABC123', 'INV-UPPER-CASE', 500);
    expect(fp).toBe(fp.toLowerCase());
  });

  it('substitutes "no-vat" when vatNumber is null', () => {
    const fp = computeFingerprint(null, 'INV-001', 100);
    expect(fp).toBe('no-vat|inv-001|100');
  });

  it('substitutes "no-inv" when invoiceNumber is null', () => {
    const fp = computeFingerprint('4150165685', null, 100);
    expect(fp).toBe('4150165685|no-inv|100');
  });

  it('substitutes 0 when totalAmount is null', () => {
    const fp = computeFingerprint('4150165685', 'INV-001', null);
    expect(fp).toBe('4150165685|inv-001|0');
  });

  it('handles all-null inputs', () => {
    const fp = computeFingerprint(null, null, null);
    expect(fp).toBe('no-vat|no-inv|0');
  });

  it('distinguishes different amounts', () => {
    const fp1 = computeFingerprint(VAT_NUMBER, INVOICE_NUM, 1000);
    const fp2 = computeFingerprint(VAT_NUMBER, INVOICE_NUM, 1001);
    expect(fp1).not.toBe(fp2);
  });
});

// ── findDuplicate ─────────────────────────────────────────────────────────────

describe('findDuplicate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── Exact fingerprint match ───────────────────────────────────────────────

  it('returns confidence 1.0 on exact fingerprint match', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeExactRow()] as never); // exact SELECT hit

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, INVOICE_NUM, TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
    expect(result!.supplierInvoiceId).toBe(INVOICE_ID);
    expect(result!.totalAmount).toBe(TOTAL_AMOUNT);
  });

  it('does not call the fuzzy SQL when an exact match is found', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeExactRow()] as never);

    await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, INVOICE_NUM, TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    // Only the exact-match SELECT was issued
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('formats invoice_date from a Date object on an exact hit', async () => {
    const dateObj = new Date('2026-01-15T00:00:00.000Z');
    vi.mocked(sqlMock).mockResolvedValueOnce([makeExactRow({ invoice_date: dateObj })] as never);

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, INVOICE_NUM, TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(result!.invoiceDate).toBe('2026-01-15');
  });

  // ── Fuzzy match — 0.95 path ───────────────────────────────────────────────

  it('returns confidence 0.95 when invoice number prefix matches within fuzzy tolerance', async () => {
    // No exact match; fuzzy row has same first-4-char prefix
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // exact — miss
    vi.mocked(sqlMock).mockResolvedValueOnce([
      makeExactRow({ invoice_number: 'INV-2026-002' }), // prefix "inv-" matches
    ] as never); // fuzzy — hit

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, 'INV-2026-999', TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.95, 5);
  });

  it('returns confidence 0.95 when invoice number suffix matches within fuzzy tolerance', async () => {
    // Last 4 chars of both are "0001"
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // exact — miss
    vi.mocked(sqlMock).mockResolvedValueOnce([
      makeExactRow({ invoice_number: 'XYZ-0001' }),
    ] as never);

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, 'ABC-0001', TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.95, 5);
  });

  // ── Fuzzy match — 0.85 path ───────────────────────────────────────────────

  it('returns confidence 0.85 when amount and date match but invoice number does not', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // exact — miss
    vi.mocked(sqlMock).mockResolvedValueOnce([
      makeExactRow({ invoice_number: 'COMPLETELY-DIFFERENT-99' }),
    ] as never); // fuzzy — hit, but no inv similarity

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, 'XXXX-1234', TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.85, 5);
  });

  it('returns confidence 0.85 when the incoming invoice number is null', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([makeExactRow()] as never);

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, null, TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    // null invoiceNumber → invoiceNumberSimilar returns false → 0.85
    expect(result!.confidence).toBeCloseTo(0.85, 5);
  });

  // ── Date boundary ─────────────────────────────────────────────────────────

  it('skips fuzzy rows where date difference is more than 2 days', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // exact — miss
    // DB returns a row whose date is 3 days away — should be skipped in JS filter
    vi.mocked(sqlMock).mockResolvedValueOnce([
      makeExactRow({ invoice_date: '2026-01-18' }), // 3 days from 2026-01-15
    ] as never);

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, INVOICE_NUM, TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(result).toBeNull();
  });

  // ── No match ──────────────────────────────────────────────────────────────

  it('returns null when there is no exact or fuzzy match', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // exact — miss
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // fuzzy — miss

    const result = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, 'INV-UNIQUE-9999', 99999, '2025-06-01', null,
    );

    expect(result).toBeNull();
  });

  it('issues exactly two SQL queries when there is no exact match', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, null, 1000, '2026-01-01', null,
    );

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(2);
  });

  // ── DuplicateHit shape ────────────────────────────────────────────────────

  it('returns a well-formed DuplicateHit on exact match', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeExactRow()] as never);

    const hit: DuplicateHit | null = await findDuplicate(
      COMPANY_ID, SUPPLIER_ID, INVOICE_NUM, TOTAL_AMOUNT, INVOICE_DATE, VAT_NUMBER,
    );

    expect(hit).toMatchObject({
      supplierInvoiceId: INVOICE_ID,
      invoiceNumber: INVOICE_NUM,
      totalAmount: TOTAL_AMOUNT,
      invoiceDate: INVOICE_DATE,
      confidence: 1.0,
    });
  });
});
