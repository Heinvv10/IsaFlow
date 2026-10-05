/**
 * postCustomerInvoiceToGL codes the invoice's VAT Output leg 'standard'
 * (2026-10-05). An uncoded VAT leg is a blocking pre-filing exception, and
 * 'standard' is what the VAT201 already read it as. Only the VAT leg is coded:
 * AR and Revenue carry no vat_type. Unit-level so GitHub CI (which skips the
 * integration twin, customer-invoice-vat-code-backfill.int.test.ts) guards it.
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

vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: vi.fn().mockResolvedValue('open'),
}));

vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/journalVatLockGuard')>()),
  assertJournalVatPeriodOpen: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreate = createJournalEntry as unknown as MockedFunction<(...args: unknown[]) => Promise<{ id: string }>>;
const mockAccount = getSystemAccount as unknown as MockedFunction<(subtype: string) => Promise<{ id: string }>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

function invoice(taxAmount: string) {
  return {
    id: INVOICE_ID, status: 'approved', gl_journal_entry_id: null,
    total_amount: String(100 + Number(taxAmount)), subtotal: '100.00', tax_amount: taxAmount,
    invoice_number: 'INV-1', invoice_date: '2026-07-01',
  };
}

async function postedLines(taxAmount: string): Promise<JournalLineInput[]> {
  mockSql.mockResolvedValueOnce([invoice(taxAmount)]);
  await postCustomerInvoiceToGL(COMPANY_ID, INVOICE_ID, USER_ID);
  return (mockCreate.mock.calls[0]![1] as { lines: JournalLineInput[] }).lines;
}

describe('postCustomerInvoiceToGL VAT Output leg code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 'je-1' });
    mockAccount.mockImplementation(async (subtype: string) => ({ id: `acct-${subtype}` }));
  });

  it('codes the VAT Output leg standard and leaves AR and Revenue uncoded', async () => {
    const lines = await postedLines('15.00');
    expect(lines.map((l) => [l.glAccountId, l.vatType])).toEqual([
      ['acct-receivable', undefined],
      ['acct-default_revenue', undefined],
      ['acct-vat_output', 'standard'],
    ]);
  });

  it('posts no VAT leg for a zero-tax invoice', async () => {
    const lines = await postedLines('0');
    expect(lines.some((l) => l.vatType !== undefined)).toBe(false);
    expect(lines).toHaveLength(2);
  });
});
