// RED phase — written before implementation
/**
 * Unit tests for evidenceAttachmentService.ts
 *
 * Covers: attachEvidenceToProvisional — happy path, amount mismatch, date
 * mismatch, supplier mismatch, idempotency (already-evidenced JE), and
 * supplier-null match (amount+date only).
 *
 * The service issues these SQL calls in order:
 *   1. SELECT captured_documents (doc row lookup)
 *   2. SELECT gl_journal_entries JOIN bank_transactions (provisional match)
 *   3. UPDATE gl_journal_entries (flip to evidenced)
 *   4. UPDATE bank_transactions  (status = 'matched')
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock, fmtDate: (x: unknown) => String(x) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC_ID      = 'cccccccc-0000-0000-0000-000000000003';
const JE_ID       = 'dddddddd-0000-0000-0000-000000000004';
const BANK_TX_ID  = 'eeeeeeee-0000-0000-0000-000000000005';

const DOCUMENT_DATE   = '2026-04-10';
const MATCHING_AMOUNT = 1200.00;

/** Captured document DB row returned by the first SELECT. */
function makeDocRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DOC_ID,
    source_document_hash: 'abc123hash',
    extraction_confidence: 0.92,
    ...overrides,
  };
}

/** Match row returned by the provisional JE JOIN query. */
function makeMatchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    je_id: JE_ID,
    bt_id: BANK_TX_ID,
    ...overrides,
  };
}

// ── attachEvidenceToProvisional ───────────────────────────────────────────────

describe('attachEvidenceToProvisional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns non-null attachedJeId and bankTxId when a matching provisional exists', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);       // captured_documents
    vi.mocked(sqlMock).mockResolvedValueOnce([makeMatchRow()] as never);     // provisional match
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);                   // UPDATE gl_journal_entries
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);                   // UPDATE bank_transactions

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    expect(result.attachedJeId).toBe(JE_ID);
    expect(result.bankTxId).toBe(BANK_TX_ID);
  });

  it('issues exactly 4 SQL calls on the happy path (1 doc SELECT + 1 match SELECT + 2 UPDATEs)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([makeMatchRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(4);
  });

  it('returns nulls and issues no UPDATEs when the captured_documents row is not found', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // doc not found

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    expect(result.attachedJeId).toBeNull();
    expect(result.bankTxId).toBeNull();
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('returns nulls and issues no UPDATEs when no provisional JE matches the amount', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // no match

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT + 0.05, DOCUMENT_DATE,
    );

    expect(result.attachedJeId).toBeNull();
    expect(result.bankTxId).toBeNull();
    // doc SELECT + match SELECT only — no UPDATEs
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(2);
  });

  it('returns nulls when the date is outside the ±2-day window', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // no match — date out of window

    // Document date 3 days after bank_tx date — exceeds ±2 day tolerance
    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, '2026-04-13',
    );

    expect(result.attachedJeId).toBeNull();
    expect(result.bankTxId).toBeNull();
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(2);
  });

  it('returns nulls when the supplier does not match the predicted supplier on the bank transaction', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // supplier mismatch → no row

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, 'ffffffff-0000-0000-0000-000000000099', MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    expect(result.attachedJeId).toBeNull();
    expect(result.bankTxId).toBeNull();
  });

  it('returns nulls without any UPDATE when the JE is already evidenced (query filter excludes it)', async () => {
    // Idempotency: needs_evidence=false in DB means the SELECT returns nothing
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // excluded by needs_evidence=true filter

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    expect(result.attachedJeId).toBeNull();
    expect(result.bankTxId).toBeNull();
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(2);
  });

  it('matches purely on amount and date when supplierId is null (uses alternative query branch)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([makeMatchRow({ bt_id: BANK_TX_ID })] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, null, MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    expect(result.attachedJeId).toBe(JE_ID);
    expect(result.bankTxId).toBe(BANK_TX_ID);
  });

  it('accepts amount exactly R0.01 within tolerance as a valid match', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([makeMatchRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT + 0.01, DOCUMENT_DATE,
    );

    // The service passes the totalAmount ±0.01 window to the query;
    // we model tolerance-passing matches by letting the SELECT return a row
    expect(result.attachedJeId).toBe(JE_ID);
  });

  it('does not throw when no provisional match exists — resolves with nulls gracefully', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await expect(
      attachEvidenceToProvisional(COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, DOCUMENT_DATE),
    ).resolves.toEqual({ attachedJeId: null, bankTxId: null });
  });

  it('returns nulls gracefully when an unexpected DB error is thrown', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeDocRow()] as never);
    vi.mocked(sqlMock).mockRejectedValueOnce(new Error('DB connection lost') as never);

    const result = await attachEvidenceToProvisional(
      COMPANY_ID, DOC_ID, SUPPLIER_ID, MATCHING_AMOUNT, DOCUMENT_DATE,
    );

    // The service catches errors and returns nulls
    expect(result.attachedJeId).toBeNull();
    expect(result.bankTxId).toBeNull();
  });
});
