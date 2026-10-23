/**
 * importARInvoices honours the wizard page's manual customer correction.
 *
 * The AR page sent `customerId` for a row the operator re-pointed, but the
 * route's schema had no such field (zod stripped it) and the service matched
 * on the name only — the override was silently ignored. Mirrors AP's
 * `supplierId`: the id must belong to this company's customers, or the row is
 * refused rather than posted against another tenant's contact.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/modules/accounting/services/gl/approvalGateExempt', () => ({
  assertMayImportOpenBills: async () => undefined,
  withApprovalGateExempt: <T,>(_importer: unknown, write: () => Promise<T>) => write(),
}));
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/migrationService', () => ({
  updateSession: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { importARInvoices, type ARInvoiceRow } from '@/modules/accounting/services/core/migrationImportService';
import { ARInvoiceRowSchema } from '@/modules/accounting/services/core/migrationRowSchemas';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreate = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockGetSystemAccountId = getSystemAccountId as unknown as MockedFunction<typeof getSystemAccountId>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const ACME_ID = '66666666-6666-6666-6666-666666666666';
const OTHER_ID = '77777777-7777-7777-7777-777777777777';
const FOREIGN_ID = '88888888-8888-8888-8888-888888888888';

const row: ARInvoiceRow = {
  invoiceNumber: 'INV-1', customerName: 'Acme Corp', invoiceDate: '2026-07-04', dueDate: '2026-08-04',
  subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 0,
};

/** The INSERT customer_invoices call's customer id parameter. */
function insertedCustomerId(): unknown {
  const call = mockSql.mock.calls.find(c => (c[0] as readonly string[]).join('').includes('INSERT INTO customer_invoices'));
  return call?.[2];
}

function primeSql(customers: Array<{ id: string; name: string }>) {
  mockSql
    .mockResolvedValueOnce([]) // advisory lock
    .mockResolvedValueOnce([]) // opening control total check
    .mockResolvedValueOnce(customers) // customers for this company
    .mockResolvedValueOnce([{ source_system: 'sage_cloud' }])
    .mockResolvedValueOnce([{ id: 'inv-1' }]) // INSERT
    .mockResolvedValueOnce([]); // UPDATE gl_journal_entry_id
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockGetSystemAccountId.mockResolvedValue('account-id');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreate.mockResolvedValue({ id: 'je-1' } as any);
});

describe('importARInvoices — customerId override', () => {
  it('posts against the customer the operator chose, not the name match', async () => {
    primeSql([{ id: ACME_ID, name: 'Acme Corp' }, { id: OTHER_ID, name: 'Other Ltd' }]);
    const result = await importARInvoices(COMPANY_ID, SESSION_ID, [{ ...row, customerId: OTHER_ID }], USER_ID);
    expect(result.imported).toBe(1);
    expect(insertedCustomerId()).toBe(OTHER_ID);
  });

  it('refuses an id that is not one of this company\'s customers', async () => {
    primeSql([{ id: ACME_ID, name: 'Acme Corp' }]);
    const result = await importARInvoices(COMPANY_ID, SESSION_ID, [{ ...row, customerId: FOREIGN_ID }], USER_ID);
    expect(result.imported).toBe(0);
    expect(result.errors[0]).toMatchObject({ step: 'ar_invoices', row: 0, field: 'customerId' });
    expect(insertedCustomerId()).toBeUndefined();
  });

  it('falls back to the name match when no override is sent', async () => {
    primeSql([{ id: ACME_ID, name: 'Acme Corp' }]);
    const result = await importARInvoices(COMPANY_ID, SESSION_ID, [{ ...row, customerId: '' }], USER_ID);
    expect(result.imported).toBe(1);
    expect(insertedCustomerId()).toBe(ACME_ID);
  });
});

describe('ARInvoiceRowSchema — customerId', () => {
  const body = {
    invoiceNumber: 'INV-1', customerName: 'Acme', invoiceDate: '2026-07-04', dueDate: '2026-08-04',
    subtotal: 1, taxAmount: 0, totalAmount: 1,
  };

  it('keeps the override instead of stripping it', () => {
    const parsed = ARInvoiceRowSchema.safeParse({ ...body, customerId: ACME_ID });
    expect(parsed.success && parsed.data.customerId).toBe(ACME_ID);
  });

  it('accepts blank and refuses a non-UUID', () => {
    expect(ARInvoiceRowSchema.safeParse({ ...body, customerId: '' }).success).toBe(true);
    expect(ARInvoiceRowSchema.safeParse({ ...body, customerId: 'nope' }).success).toBe(false);
  });

  it('accepts a South African dd/mm/yyyy date and normalises it to ISO', () => {
    const parsed = ARInvoiceRowSchema.safeParse({ ...body, invoiceDate: '03/04/2026', dueDate: '3 May 2026' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.invoiceDate).toBe('2026-04-03');
    expect(parsed.success && parsed.data.dueDate).toBe('2026-05-03');
  });
});
