/**
 * `source_record_id` — the link from a journal to the record that caused it.
 *
 * Migration 409 gave `source_document_id` an FK to captured_documents, and two
 * services kept writing a non-document id into it: the bank-recon adjustment
 * (a reconciliation id) and DRC VAT (a supplier invoice id). Both threw on
 * INSERT. These prove they now write `sourceRecordId` instead — put either id
 * back on `sourceDocumentId` and the DB-gated half goes red on the FK.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return { ...actual, sql: vi.fn() };
});

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { createAdjustmentEntry } from '@/modules/accounting/services/bank/bankReconciliationService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { applyDRCVat } from '@/modules/accounting/services/reports/drcVatService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RECON_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const BANK_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CONTRA_ID = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID = 'ffffffff-0000-0000-0000-000000000006';
const INVOICE_ID = 'dddddddd-0000-0000-0000-000000000004';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never);
});

describe('createAdjustmentEntry', () => {
  it('links the reconciliation through sourceRecordId, never sourceDocumentId', async () => {
    // getReconciliationById, then updateReconciledBalance.
    vi.mocked(sql).mockResolvedValue([
      { id: RECON_ID, bank_account_id: BANK_ID, statement_date: '2026-08-31',
        statement_balance: 0, gl_balance: 0, reconciled_balance: 0, difference: 0,
        status: 'in_progress', started_by: USER_ID, started_at: 'now',
        created_at: 'now', updated_at: 'now' },
    ] as never);

    await createAdjustmentEntry(
      COMPANY_ID, RECON_ID, BANK_ID, CONTRA_ID, 150, 'bank charges', USER_ID,
    );

    const input = vi.mocked(createJournalEntry).mock.calls[0]![1];
    expect(input.source).toBe('auto_bank_recon');
    expect(input.sourceRecordId).toBe(RECON_ID);
    // The FK column must stay empty — a reconciliation is not a captured document.
    expect(input.sourceDocumentId).toBeUndefined();
  });
});

describe('applyDRCVat', () => {
  it('links the supplier invoice through sourceRecordId, never sourceDocumentId', async () => {
    vi.mocked(getSystemAccountId).mockResolvedValue('acct-vat' as never);
    vi.mocked(sql)
      // invoice lookup
      .mockResolvedValueOnce([
        { id: INVOICE_ID, invoice_number: 'INV-1', subtotal: 1000, total_amount: 1150, is_drc: false },
      ] as never)
      // vat_rate setting
      .mockResolvedValueOnce([{ value: '0.15' }] as never)
      // UPDATE supplier_invoices
      .mockResolvedValueOnce([] as never);

    await applyDRCVat(COMPANY_ID, INVOICE_ID, USER_ID);

    const input = vi.mocked(createJournalEntry).mock.calls[0]![1];
    expect(input.source).toBe('auto_vat_adjustment');
    expect(input.sourceRecordId).toBe(INVOICE_ID);
    expect(input.sourceDocumentId).toBeUndefined();
  });
});
