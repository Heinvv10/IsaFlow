/**
 * postCustomerInvoiceToGL must refuse cancelled invoices (PR #198 round 4).
 *
 * Cancel NULLs gl_journal_entry_id after reversing the journal, which re-arms
 * the "backfill" early-return — without a status guard, the GL backfill route
 * (POST /api/accounting/customer-invoices-gl) would post a fresh
 * DR AR / CR Revenue / CR VAT journal for a cancelled document: the inverse
 * of audit C1's overstatement.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

describe('postCustomerInvoiceToGL cancelled guard (PR #198 R4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to post a cancelled invoice even though its journal link is NULL', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: INVOICE_ID,
        status: 'cancelled',
        gl_journal_entry_id: null,
        total_amount: '115.00',
        subtotal: '100.00',
        tax_amount: '15.00',
        invoice_number: 'INV-X',
        invoice_date: '2026-07-01',
      },
    ]);

    await expect(postCustomerInvoiceToGL(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /cancelled/i,
    );
    // Never got as far as resolving accounts or posting.
    expect(getSystemAccount).not.toHaveBeenCalled();
  });
});
