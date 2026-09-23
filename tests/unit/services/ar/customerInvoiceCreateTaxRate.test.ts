/**
 * R-119 — `createDraftCustomerInvoice` takes `taxRate` off the request body
 * and uses it for `tax_amount` and the output-VAT journal leg. A negative
 * rate leaves the TOTAL positive — `subtotal 1000, tax -500, total 500` — so
 * neither a total guard nor migration 692's total arm sees it, while the VAT
 * return and the GL leg go negative.
 *
 * The same audit that added the line guards here ("the July-4 audit created a
 * -R115.00 invoice through this handler") left this field open. Thrown as an
 * InvoiceLineValidationError so the route answers 400 rather than the 500 the
 * database trigger would otherwise produce.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((t: string) => t) });
  return { ...actual, sql: sqlMock, withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(),
  CustomerNotInCompanyError: class extends Error {},
}));

import { sql } from '@/lib/neon';
import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const input = (taxRate?: unknown) => ({
  clientId: CLIENT,
  items: [{ description: 'Consulting', unitPrice: 1000, quantity: 1 }],
  ...(taxRate === undefined ? {} : { taxRate: taxRate as number }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('createDraftCustomerInvoice — R-119 tax rate', () => {
  it.each([
    ['negative', -50],
    ['above 100', 150],
    ['not a number', Number.NaN],
  ])('refuses a %s tax rate before writing anything', async (_label, rate) => {
    await expect(createDraftCustomerInvoice(COMPANY, USER, input(rate)))
      .rejects.toBeInstanceOf(InvoiceLineValidationError);

    // Refused before the first write: no INSERT, so the operator gets the 400
    // the route maps this error to, not the trigger's 23514 as a 500.
    const inserts = mockSql.mock.calls.filter((c) =>
      String((c as [readonly string[]])[0]?.join?.('') ?? '').includes('INSERT INTO customer_invoices'));
    expect(inserts).toHaveLength(0);
  });

  it.each([15, 0, 100, undefined])('lets rate %s past the guard', async (rate) => {
    // `sql` is mocked to return [], so the call fails LATER, reading the
    // inserted row back. What this asserts is that it gets past the guard —
    // the failure is anything but an InvoiceLineValidationError.
    const err = await createDraftCustomerInvoice(COMPANY, USER, input(rate)).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(InvoiceLineValidationError);
  });
});
