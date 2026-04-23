// RED phase — written before implementation
/**
 * Unit tests for evidenceGraphService.ts
 *
 * Covers: resolveAccountEvidence, resolveJournalEntryEvidence.
 * SQL is mocked via vi.mock('@/lib/neon'); tests assert on call count and
 * mapped return shapes rather than raw SQL strings.
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
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  resolveAccountEvidence,
  resolveJournalEntryEvidence,
} from '@/modules/accounting/services/core/evidenceGraphService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const GL_ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const JE_ID        = 'cccccccc-0000-0000-0000-000000000003';
const JL_ID        = 'dddddddd-0000-0000-0000-000000000004';
const DOC_ID       = 'eeeeeeee-0000-0000-0000-000000000005';

function makeEvidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    je_id:                 JE_ID,
    entry_date:            '2026-03-15',
    entry_number:          'JE-2026-00042',
    description:           'Supplier payment',
    debit:                 0,
    credit:                10000,
    posting_agent:         'ai:ai-invoice-pipeline:v1',
    extraction_confidence: 0.92,
    source_document_id:    DOC_ID,
    document_vendor:       'Makro SA',
    document_reference:    'MKR-2026-0999',
    document_date:         '2026-03-15',
    document_thumbnail_url: null,
    ...overrides,
  };
}

function makeJeRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                   JE_ID,
    entry_number:         'JE-2026-00042',
    entry_date:           '2026-03-15',
    description:          'Supplier payment — Makro',
    source:               'ap',
    posting_agent:        'ai:ai-invoice-pipeline:v1',
    extraction_confidence: 0.92,
    source_document_id:   DOC_ID,
    source_document_hash: 'abc123',
    ...overrides,
  };
}

function makeLineRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                     JL_ID,
    gl_account_id:          GL_ACCOUNT_ID,
    gl_account_name:        'Accounts Payable Control',
    debit:                  0,
    credit:                 10000,
    description:            null,
    source_document_line_id: null,
    ...overrides,
  };
}

function makeDocRow(overrides: Record<string, unknown> = {}) {
  return {
    id:               DOC_ID,
    vendor_name:      'Makro SA',
    document_date:    '2026-03-15',
    reference_number: 'MKR-2026-0999',
    total_amount:     10000,
    vat_amount:       1304.35,
    status:           'posted',
    ...overrides,
  };
}

// ── resolveAccountEvidence ────────────────────────────────────────────────────

describe('resolveAccountEvidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped AccountEvidenceRow array for a GL account', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEvidenceRow()] as never);

    const rows = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.jeId).toBe(JE_ID);
    expect(row.entryDate).toBe('2026-03-15');
    expect(row.entryNumber).toBe('JE-2026-00042');
    expect(row.debit).toBe(0);
    expect(row.credit).toBe(10000);
    expect(row.postingAgent).toBe('ai:ai-invoice-pipeline:v1');
    expect(row.sourceDocumentId).toBe(DOC_ID);
    expect(row.documentVendor).toBe('Makro SA');
    // PRD-06: when the JE is not AR-backed, both AR fields stay null.
    expect(row.customerInvoiceId).toBeNull();
    expect(row.sealedPdfUrl).toBeNull();
  });

  it('surfaces sealedPdfUrl when the JE is backed by a customer invoice', async () => {
    const CI_ID = 'cccccccc-0000-0000-0000-0000deadbeef';
    vi.mocked(sql).mockResolvedValueOnce([
      makeEvidenceRow({ customer_invoice_id: CI_ID, customer_invoice_number: 'INV-2026-0001' }),
    ] as never);

    const [row] = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);
    expect(row!.customerInvoiceId).toBe(CI_ID);
    expect(row!.sealedPdfUrl).toBe(`/api/accounting/ar/invoice/${CI_ID}/pdf`);
  });

  it('passes fromDate and toDate opts — sql is called once (params embedded in template)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEvidenceRow()] as never);

    await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID, {
      fromDate: '2026-01-01',
      toDate:   '2026-03-31',
    });

    // Single SQL call containing all four parameters: companyId, glAccountId, fromDate, toDate
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    // The tagged template receives the four interpolated values; assert the mock was given them
    const callArgs = vi.mocked(sql).mock.calls[0];
    // callArgs is [TemplateStringsArray, ...values] — the values should include our date strings
    const interpolatedValues = callArgs?.slice(1) as unknown[];
    expect(interpolatedValues).toContain('2026-01-01');
    expect(interpolatedValues).toContain('2026-03-31');
  });

  it('passes null date params when opts are omitted (no filtering)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolatedValues = callArgs?.slice(1) as unknown[];
    // Both date params should be null
    const nullCount = interpolatedValues.filter(v => v === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array when GL account has no posted journal lines', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const rows = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);
    expect(rows).toHaveLength(0);
  });

  it('maps debit and credit as numbers (not strings)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeEvidenceRow({ debit: '1234.56', credit: '0' }),
    ] as never);

    const [row] = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);
    expect(typeof row!.debit).toBe('number');
    expect(typeof row!.credit).toBe('number');
    expect(row!.debit).toBeCloseTo(1234.56, 2);
  });

  it('maps extractionConfidence as null when column is null (legacy rows)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeEvidenceRow({ extraction_confidence: null }),
    ] as never);

    const [row] = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);
    expect(row!.extractionConfidence).toBeNull();
  });

  it('maps sourceDocumentId as null when source_document_id is null (legacy rows)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeEvidenceRow({ source_document_id: null, document_vendor: null, document_reference: null, document_date: null }),
    ] as never);

    const [row] = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);
    expect(row!.sourceDocumentId).toBeNull();
    expect(row!.documentVendor).toBeNull();
  });

  it('always returns documentThumbnailUrl as null (not yet implemented)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEvidenceRow()] as never);

    const [row] = await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID);
    expect(row!.documentThumbnailUrl).toBeNull();
  });

  it('respects the limit option — passes it to sql template', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID, { limit: 10 });

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolatedValues = callArgs?.slice(1) as unknown[];
    expect(interpolatedValues).toContain(10);
  });

  it('propagates sql errors to caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('query timeout') as never);

    await expect(
      resolveAccountEvidence(COMPANY_ID, GL_ACCOUNT_ID),
    ).rejects.toThrow('query timeout');
  });
});

// ── resolveJournalEntryEvidence ───────────────────────────────────────────────

describe('resolveJournalEntryEvidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for an unknown jeId (empty DB result)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await resolveJournalEntryEvidence(COMPANY_ID, 'non-existent-je-id');
    expect(result).toBeNull();
  });

  it('returns null when jeId exists but belongs to a different company', async () => {
    // The WHERE clause filters by both id AND company_id — wrong company means empty result
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await resolveJournalEntryEvidence('wrong-company', JE_ID);
    expect(result).toBeNull();
  });

  it('returns JeEvidenceDetail with je, lines, and document on full match', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);          // je query
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never);        // lines query
    vi.mocked(sql).mockResolvedValueOnce([] as never);                     // arLink (no AR invoice)
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow()] as never);         // document query

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);

    expect(detail).not.toBeNull();
    expect(detail!.je.id).toBe(JE_ID);
    expect(detail!.je.entryNumber).toBe('JE-2026-00042');
    expect(detail!.je.postingAgent).toBe('ai:ai-invoice-pipeline:v1');
    expect(detail!.je.extractionConfidence).toBeCloseTo(0.92, 2);
    expect(detail!.je.sourceDocumentId).toBe(DOC_ID);
    expect(detail!.lines).toHaveLength(1);
    expect(detail!.lines[0]!.glAccountName).toBe('Accounts Payable Control');
    expect(detail!.document).not.toBeNull();
    expect(detail!.document!.vendorName).toBe('Makro SA');
  });

  it('returns document=null when source_document_id is null on the JE (legacy rows)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow({ source_document_id: null })] as never);
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss too
    // No fourth sql call — document query is skipped when effectiveDocId is null

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);

    expect(detail).not.toBeNull();
    expect(detail!.document).toBeNull();
    // Only 3 sql calls: je + lines + arLink (no doc lookup)
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });

  it('returns document=null when source_document_id set but document row not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss
    vi.mocked(sql).mockResolvedValueOnce([] as never); // doc query returns empty

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);

    expect(detail!.document).toBeNull();
  });

  it('maps line debit and credit as numbers', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow({ debit: '5000', credit: '0' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow()] as never);

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);
    expect(typeof detail!.lines[0]!.debit).toBe('number');
    expect(detail!.lines[0]!.debit).toBeCloseTo(5000, 2);
  });

  it('maps document totalAmount and vatAmount as numbers', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow({ total_amount: '10000', vat_amount: '1304.35' })] as never);

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);
    expect(typeof detail!.document!.totalAmount).toBe('number');
    expect(detail!.document!.totalAmount).toBeCloseTo(10000, 2);
    expect(detail!.document!.vatAmount).toBeCloseTo(1304.35, 2);
  });

  it('maps null nullable JE fields as null', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeJeRow({ description: null, posting_agent: null, extraction_confidence: null, source_document_hash: null }),
    ] as never);
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow()] as never);

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);
    expect(detail!.je.description).toBeNull();
    expect(detail!.je.postingAgent).toBeNull();
    expect(detail!.je.extractionConfidence).toBeNull();
    expect(detail!.je.sourceDocumentHash).toBeNull();
  });

  it('returns empty lines array when JE has no journal lines', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // no lines
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow()] as never);

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);
    expect(detail!.lines).toHaveLength(0);
  });

  // ── PRD-06 Phase 1: AR snapshot drill-through ─────────────────────────────
  it('prefers the AR customer_invoice snapshot over the JE source_document_id', async () => {
    const CI_ID = 'cccccccc-0000-0000-0000-000000001234';
    const AR_DOC_ID = 'dddddddd-0000-0000-0000-00000000abcd';

    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);   // je
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never); // lines
    vi.mocked(sql).mockResolvedValueOnce([
      { id: CI_ID, source_document_id: AR_DOC_ID },
    ] as never); // arLink hit with sealed snapshot
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow({ id: AR_DOC_ID })] as never);

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);

    expect(detail!.customerInvoiceId).toBe(CI_ID);
    expect(detail!.sealedPdfUrl).toBe(`/api/accounting/ar/invoice/${CI_ID}/pdf`);
    expect(detail!.document!.id).toBe(AR_DOC_ID);
  });

  it('leaves customerInvoiceId and sealedPdfUrl null for non-AR JEs', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeJeRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([makeLineRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // arLink miss
    vi.mocked(sql).mockResolvedValueOnce([makeDocRow()] as never);

    const detail = await resolveJournalEntryEvidence(COMPANY_ID, JE_ID);
    expect(detail!.customerInvoiceId).toBeNull();
    expect(detail!.sealedPdfUrl).toBeNull();
  });

  it('propagates sql errors to caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('connection refused') as never);

    await expect(
      resolveJournalEntryEvidence(COMPANY_ID, JE_ID),
    ).rejects.toThrow('connection refused');
  });
});
