/**
 * Approving a customer invoice must not survive a failed GL post.
 *
 * approveCustomerInvoice flips the invoice to 'approved' in a guarded UPDATE
 * and then posts DR AR / CR Revenue / CR VAT Output. The GL call sat in a
 * try/catch that logged and continued, so a failed post left the invoice
 * approved — sitting in AR — with gl_journal_entry_id NULL and no journal
 * behind it. AR and the GL disagree by the invoice total, permanently and
 * silently. (scripts/backfill-auto-postings.ts exists because this fires in
 * practice; demo invoices INV0000002-6 are the evidence.)
 *
 * The AP equivalent, approveSupplierInvoice, has always let the error
 * propagate. This pins AR to the same rule: the throw reaches withAuth, the
 * request transaction rolls back, and the status UPDATE goes with it.
 *
 * The PDF snapshot deliberately keeps its swallow — evidence sealing is not
 * ledger state, and a flaky object store should not block an approval.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/impersonationGuard.test.ts and the r-032 integration suites.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([{ id: 'inv-1', total_amount: '115.00' }]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  postCustomerInvoiceToGL: vi.fn().mockResolvedValue('je-1'),
}));

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn().mockResolvedValue({ documentId: 'doc-1', wasExisting: false }),
}));
// R-035 PR4: the approval gate has its own real-PG suites (r035-pr4-*); here it clears.
vi.mock('@/modules/accounting/services/gl/approvalGate', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/approvalGate')>()),
  assertApprovalCleared: vi.fn(async () => undefined),
}));

import { sql } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentService';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';
import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const INVOICE = '44444444-4444-4444-4444-444444444444';
const USER = '22222222-2222-2222-2222-222222222222';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const postGlMock = postCustomerInvoiceToGL as unknown as MockedFunction<
  (...a: unknown[]) => Promise<string>
>;
const snapshotMock = snapshotInvoicePdf as unknown as MockedFunction<
  (...a: unknown[]) => Promise<{ documentId: string; wasExisting: boolean }>
>;

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ id: INVOICE, total_amount: '115.00' }]); // the lock row carries the total (R0.00 is refused)
  postGlMock.mockResolvedValue('je-1');
  snapshotMock.mockResolvedValue({ documentId: 'doc-1', wasExisting: false });
});

describe('approveCustomerInvoice', () => {
  it('returns the journal id on the happy path', async () => {
    const result = await approveCustomerInvoice(COMPANY, INVOICE, USER);

    expect(result).toMatchObject({
      id: INVOICE,
      status: 'approved',
      glJournalEntryId: 'je-1',
      evidenceDocumentId: 'doc-1',
    });
  });

  it('PROPAGATES a GL posting failure instead of leaving the invoice approved', async () => {
    postGlMock.mockRejectedValue(new Error('Cannot post to closed fiscal period'));

    await expect(approveCustomerInvoice(COMPANY, INVOICE, USER))
      .rejects.toThrow(/closed fiscal period/);
  });

  it('does not seal PDF evidence for an invoice whose journal never posted', async () => {
    postGlMock.mockRejectedValue(new Error('GL down'));

    await expect(approveCustomerInvoice(COMPANY, INVOICE, USER)).rejects.toThrow('GL down');

    // Evidence for an approval that is about to be rolled back would outlive
    // the transaction if the snapshot writes to object storage.
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('still swallows a PDF snapshot failure — evidence is not ledger state', async () => {
    snapshotMock.mockRejectedValue(new Error('bucket unreachable'));

    const result = await approveCustomerInvoice(COMPANY, INVOICE, USER);

    expect(result.status).toBe('approved');
    expect(result.glJournalEntryId).toBe('je-1');
    expect(result.evidenceDocumentId).toBeNull();
  });

  it('still rejects a non-approvable invoice before touching the GL', async () => {
    // Guarded UPDATE matches nothing, then the status lookup returns 'cancelled'.
    sqlMock
      .mockResolvedValueOnce([]) // the row lock (R-035) matches approvable invoices only: none, so no gate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'cancelled' }]);

    await expect(approveCustomerInvoice(COMPANY, INVOICE, USER))
      .rejects.toBeInstanceOf(InvoiceNotApprovableError);
    expect(postGlMock).not.toHaveBeenCalled();
  });
});
