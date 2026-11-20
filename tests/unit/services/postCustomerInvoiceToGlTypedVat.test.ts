/**
 * postCustomerInvoiceToGL and an invoice whose lines carry their VAT type (migration 1008): the revenue legs carry
 * each line group's type and the VAT Output leg is one per rated type, from the STORED lines; a partly typed invoice
 * or one whose lines do not foot is refused before any journal is created. The legacy shape is pinned unchanged by
 * postCustomerInvoiceToGlVatCode.test.ts.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/modules/accounting/services/shared/documentCurrency', async (importOriginal) =>
  (await import('../helpers/documentCurrencyMock')).documentCurrencyMock(await importOriginal()));
vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry: vi.fn(), postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({ getPeriodStatusForDate: vi.fn().mockResolvedValue('open') }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/journalVatLockGuard')>()),
  assertJournalVatPeriodOpen: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreate = createJournalEntry as unknown as MockedFunction<(...args: unknown[]) => Promise<{ id: string }>>;
const mockAccount = getSystemAccount as unknown as MockedFunction<(subtype: string) => Promise<{ id: string }>>;

const INVOICE = {
  id: 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa', status: 'approved', gl_journal_entry_id: null, invoice_number: 'INV-7',
  invoice_date: '2026-07-01', subtotal: '1500.00', tax_amount: '150.00', total_amount: '1650.00', amounts_are: null,
};
/** storedInvoiceLines' rows: the header columns repeat on every line. */
const row = (amount: string, vatType: string | null, taxAmount: string | null, i: number) => ({
  invoice_number: 'INV-7', subtotal: '1500.00', tax_amount: '150.00', amounts_are: null, customer_fno_id: null,
  line_id: `line-${i}`, amount, gl_account_id: null, project_id: null, cc1_id: null, cc2_id: null, bu_id: null,
  line_vat_type: vatType, line_tax_amount: taxAmount,
});

/** Header overrides for one test (reset in beforeEach). */
const INVOICE_OVER: { value: Record<string, unknown> } = { value: {} };

/** sql answered by statement, not by call order: the invoice read, the stored-lines read, anything else empty. */
function answer(lines: Record<string, unknown>[]) {
  mockSql.mockImplementation(async (strings: unknown) => {
    const text = (strings as readonly string[]).join('?');
    if (/SELECT ci\.\*, c\.name AS client_name/.test(text)) return [{ ...INVOICE, ...INVOICE_OVER.value }];
    if (/LEFT JOIN customer_invoice_items cii ON cii\.invoice_id = ci\.id/.test(text)) return lines;
    return [];
  });
}

async function post(lines: Record<string, unknown>[]): Promise<JournalLineInput[]> {
  answer(lines);
  await postCustomerInvoiceToGL('cccccccc-0000-4000-8000-cccccccccccc', INVOICE.id, 'ffffffff-0000-4000-8000-ffffffffffff');
  return (mockCreate.mock.calls[0]![1] as { lines: JournalLineInput[] }).lines;
}

describe('postCustomerInvoiceToGL, lines carrying their VAT type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    INVOICE_OVER.value = {};
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 'je-1' });
    mockAccount.mockImplementation(async (subtype: string) => ({ id: `acct-${subtype}` }));
  });

  it('posts a revenue leg per type and one VAT Output leg per rated type, all coded', async () => {
    const lines = await post([row('1000.00', 'standard', '150.00', 0), row('300.00', 'zero_rated', '0.00', 1),
      row('200.00', 'exempt', '0.00', 2)]);
    expect(lines.map((l) => [l.glAccountId, l.debit, l.credit, l.vatType])).toEqual([
      ['acct-receivable', 1650, 0, undefined],
      ['acct-default_revenue', 0, 1000, 'standard'],
      ['acct-default_revenue', 0, 300, 'zero_rated'],
      ['acct-default_revenue', 0, 200, 'exempt'],
      ['acct-vat_output', 0, 150, 'standard'],
    ]);
  });

  it('an inclusive invoice posts each line\'s stored net and VAT: unit price 115 incl., amount 100, VAT 15', async () => {
    INVOICE_OVER.value = { subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00', amounts_are: 'inclusive' };
    const lines = await post([{ ...row('100.00', 'standard', '15.00', 0), unit_price: '115.00', subtotal: '100.00', tax_amount: '15.00' }]);
    expect(lines.map((l) => [l.glAccountId, l.debit, l.credit, l.vatType])).toEqual([
      ['acct-receivable', 115, 0, undefined],
      ['acct-default_revenue', 0, 100, 'standard'],
      ['acct-vat_output', 0, 15, 'standard'],
    ]);
  });

  it('an inclusive invoice whose line stores its gross (115) as the amount is refused as not footing', async () => {
    INVOICE_OVER.value = { subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00', amounts_are: 'inclusive' };
    const err = await post([{ ...row('115.00', 'standard', '15.00', 0), unit_price: '115.00', subtotal: '100.00', tax_amount: '15.00' }])
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/line 1 is standard: its VAT on 115\.00 at 15% is 17\.25, but it carries 15\.00/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a header tax_amount of NULL reads as 0: an exempt invoice posts; a standard one is refused as not footing', async () => {
    INVOICE_OVER.value = { subtotal: '200.00', tax_amount: null, total_amount: '200.00' };
    const lines = await post([row('200.00', 'exempt', '0.00', 0)]);
    expect(lines.map((l) => [l.debit, l.credit, l.vatType])).toEqual([[200, 0, undefined], [0, 200, 'exempt']]);
    mockCreate.mockClear();
    INVOICE_OVER.value = { subtotal: '100.00', tax_amount: null, total_amount: '115.00' };
    const err = await post([row('100.00', 'standard', '15.00', 0)]).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/its lines' VAT adds up to 15\.00 but its VAT total is 0\.00/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the invoice row\'s amounts_are reaches the cent tolerance: VAT 15.01 on 100.00 posts if inclusive, is refused if not', async () => {
    INVOICE_OVER.value = { subtotal: '100.00', tax_amount: '15.01', total_amount: '115.01', amounts_are: 'inclusive' };
    const lines = await post([{ ...row('100.00', 'standard', '15.01', 0), subtotal: '100.00', tax_amount: '15.01' }]);
    expect(lines.filter((l) => l.glAccountId === 'acct-vat_output').map((l) => [l.credit, l.vatType])).toEqual([[15.01, 'standard']]);
    mockCreate.mockClear();
    INVOICE_OVER.value = { subtotal: '100.00', tax_amount: '15.01', total_amount: '115.01', amounts_are: null };
    const err = await post([{ ...row('100.00', 'standard', '15.01', 0), subtotal: '100.00', tax_amount: '15.01' }]).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/line 1 is standard: its VAT on 100\.00 at 15% is 15\.00, but it carries 15\.01/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a partly typed invoice before any journal is created', async () => {
    const err = await post([row('1000.00', 'standard', '150.00', 0), row('500.00', null, null, 1)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses typed lines that do not foot to the header, before any journal is created', async () => {
    const err = await post([row('1000.00', 'standard', '150.00', 0), row('499.99', 'exempt', '0.00', 1)])
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/its lines' net adds up to 1499.99 but its subtotal is 1500.00/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
