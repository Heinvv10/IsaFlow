// RED phase — written before implementation
/**
 * Unit tests for invoicePdfSnapshotService.ts
 *
 * Verifies:
 *   1. First call renders the PDF, uploads to 'customer-invoices', inserts a
 *      captured_documents row (document_type='sent_invoice'), then stamps
 *      customer_invoices with source_document_id + rendered_pdf_*.
 *   2. Second call on the same invoice is a no-op — returns the cached row
 *      without re-rendering or re-uploading.
 *   3. SHA-256 of the uploaded bytes matches what is written to both
 *      captured_documents.raw_bytes_sha256 AND customer_invoices.rendered_pdf_sha256.
 *   4. Company scoping: the snapshot lookup includes the companyId predicate.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import crypto from 'node:crypto';

// ── Module mocks (must precede imports) ──────────────────────────────────────

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/ar/invoicePdfBuilder', () => ({
  generateInvoicePdf: vi.fn(),
}));

vi.mock('@/lib/supabaseStorage', () => ({
  CUSTOMER_INVOICES_BUCKET: 'customer-invoices',
  uploadCustomerInvoicePdf: vi.fn(),
  ensureCustomerInvoicesBucket: vi.fn(async () => undefined),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { sql } from '@/lib/neon';
import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import { uploadCustomerInvoicePdf } from '@/lib/supabaseStorage';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockGenerate = generateInvoicePdf as unknown as MockedFunction<
  (companyId: string, invoiceId: string) => Promise<Buffer>
>;
const mockUpload = uploadCustomerInvoicePdf as unknown as MockedFunction<
  (companyId: string, documentId: string, buffer: Buffer) => Promise<{ bucket: string; path: string }>
>;

// ── Shared test data ─────────────────────────────────────────────────────────

const COMPANY_ID = 'comp-0000-0000-0000-000000000001';
const INVOICE_ID = 'inv0-0000-0000-0000-000000000001';
const DOCUMENT_ID = 'doc0-0000-0000-0000-000000000001';
const PDF_BYTES = Buffer.from('%PDF-1.4 fake-invoice-bytes');
const EXPECTED_SHA = crypto.createHash('sha256').update(PDF_BYTES).digest('hex');
const STORAGE_PATH = `${COMPANY_ID}/${DOCUMENT_ID}`;

function mockFreshInvoice(): void {
  // 1st query: lookup existing snapshot (returns unsnapshotted row)
  mockSql.mockResolvedValueOnce([
    {
      id: INVOICE_ID,
      company_id: COMPANY_ID,
      invoice_number: 'INV-2026-0001',
      source_document_id: null,
      rendered_pdf_storage_path: null,
      rendered_pdf_sha256: null,
      rendered_pdf_rendered_at: null,
    },
  ]);
  // 2nd query: INSERT captured_documents RETURNING id
  mockSql.mockResolvedValueOnce([{ id: DOCUMENT_ID }]);
  // 3rd query: UPDATE captured_documents SET storage_bucket/path
  mockSql.mockResolvedValueOnce([]);
  // 4th query: UPDATE customer_invoices SET source_document_id etc
  mockSql.mockResolvedValueOnce([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerate.mockResolvedValue(PDF_BYTES);
  mockUpload.mockResolvedValue({ bucket: 'customer-invoices', path: STORAGE_PATH });
});

describe('snapshotInvoicePdf — first call (fresh invoice)', () => {
  it('renders, uploads, inserts captured_documents row, stamps invoice', async () => {
    mockFreshInvoice();

    const result = await snapshotInvoicePdf(COMPANY_ID, INVOICE_ID);

    expect(result).toMatchObject({
      invoiceId: INVOICE_ID,
      documentId: DOCUMENT_ID,
      bucket: 'customer-invoices',
      path: STORAGE_PATH,
      sha256: EXPECTED_SHA,
      bytesLength: PDF_BYTES.length,
      wasExisting: false,
    });

    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(mockGenerate).toHaveBeenCalledWith(COMPANY_ID, INVOICE_ID);
    expect(mockUpload).toHaveBeenCalledOnce();
    expect(mockUpload.mock.calls[0]![0]).toBe(COMPANY_ID);
    expect(mockUpload.mock.calls[0]![2]).toBe(PDF_BYTES);
    // 1 SELECT + 1 INSERT + 2 UPDATEs = 4 sql calls total
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('writes matching sha256 to captured_documents AND customer_invoices', async () => {
    mockFreshInvoice();

    await snapshotInvoicePdf(COMPANY_ID, INVOICE_ID);

    // Look for the sha in the INSERT captured_documents call args
    const insertArgs = mockSql.mock.calls[1]!;
    const insertValues = insertArgs.slice(1);
    expect(insertValues).toContain(EXPECTED_SHA);

    // And in the customer_invoices UPDATE
    const updateInvoiceArgs = mockSql.mock.calls[3]!;
    const updateValues = updateInvoiceArgs.slice(1);
    expect(updateValues).toContain(EXPECTED_SHA);
  });

  it('scopes the existing-snapshot lookup by company_id', async () => {
    mockFreshInvoice();

    await snapshotInvoicePdf(COMPANY_ID, INVOICE_ID);

    const lookupArgs = mockSql.mock.calls[0]!;
    const lookupValues = lookupArgs.slice(1);
    expect(lookupValues).toContain(COMPANY_ID);
    expect(lookupValues).toContain(INVOICE_ID);
  });
});

describe('snapshotInvoicePdf — idempotency', () => {
  it('no-op when already snapshotted: returns cached metadata, no render, no upload', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: INVOICE_ID,
        company_id: COMPANY_ID,
        invoice_number: 'INV-2026-0001',
        source_document_id: DOCUMENT_ID,
        rendered_pdf_storage_path: STORAGE_PATH,
        rendered_pdf_sha256: EXPECTED_SHA,
        rendered_pdf_rendered_at: new Date('2026-04-20T10:00:00Z'),
      },
    ]);

    const result = await snapshotInvoicePdf(COMPANY_ID, INVOICE_ID);

    expect(result.wasExisting).toBe(true);
    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(result.sha256).toBe(EXPECTED_SHA);
    expect(result.path).toBe(STORAGE_PATH);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    // Only the SELECT happened
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('throws when invoice does not exist in this company', async () => {
    mockSql.mockResolvedValueOnce([]);

    await expect(snapshotInvoicePdf(COMPANY_ID, INVOICE_ID)).rejects.toThrow(/not found/i);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
