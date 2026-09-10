/**
 * R-067 — every write path that stores a caller-supplied customer id refuses a
 * foreign one BEFORE its first write.
 *
 * The order matters as much as the refusal: `withAuth` COMMITs a 4xx returned
 * AFTER a write, and three of these paths burn a document number (an UPDATE of
 * the company's counter) as their very first statement. So each case asserts
 * both that the call is refused and that the ownership SELECT was the ONLY
 * statement that ran.
 *
 * The counterpart direction — an own-tenant customer proceeds — is asserted by
 * letting the same call run with the customer row present and checking that
 * execution reached the path's next statement.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const sqlTexts: string[] = [];

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      sqlTexts.push(strings.join('?'));
      return Promise.resolve([]);
    }),
    { transaction: vi.fn(async () => []), unsafe: vi.fn((s: string) => s) },
  );
  return {
    sql: sqlMock,
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => Promise.resolve().then(fn)),
    withTransaction: vi.fn((cb: (tx: unknown) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const reserveNextDocumentNumber = vi.hoisted(() => vi.fn(async () => 'INV-00001'));
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  reserveNextDocumentNumber,
}));

import { sql } from '@/lib/neon';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { createQuote, updateQuote } from '@/modules/accounting/services/ar/quoteService';
import { createSalesOrder, updateSalesOrder } from '@/modules/accounting/services/ar/salesOrderService';
import { createRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { createPracticeClient, updatePracticeClient } from '@/modules/accounting/services/practice/practiceClientService';
import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';

/** A statement that changes data — what must not run before the refusal. */
function writeStatements(): string[] {
  return sqlTexts.filter((t) => /\b(INSERT|UPDATE|DELETE)\b/i.test(t));
}

/**
 * Every path below is invoked twice. `owned: false` leaves the customers SELECT
 * returning no rows (the foreign id); `owned: true` returns a row so the call
 * proceeds into the rest of the path, which the empty mock then fails — the
 * point is only that it got there.
 */
const CASES: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: 'createDraftCustomerInvoice',
    run: () => createDraftCustomerInvoice(COMPANY, USER, {
      clientId: FOREIGN,
      items: [{ description: 'Consulting', unitPrice: 100, quantity: 1 }],
    }),
  },
  {
    name: 'createQuote',
    run: () => createQuote(COMPANY, {
      clientId: FOREIGN, customerName: 'Acme',
      lines: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
    }, USER),
  },
  {
    name: 'createSalesOrder',
    run: () => createSalesOrder(COMPANY, {
      customer_id: FOREIGN,
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
    }, USER),
  },
  {
    name: 'createRecurringInvoice',
    run: () => createRecurringInvoice(COMPANY, {
      templateName: 'Monthly retainer', clientId: FOREIGN,
      frequency: 'monthly', nextRunDate: '2026-10-01',
      lineItems: [{ description: 'Retainer', quantity: 1, unitPrice: 100 }],
    }, USER),
  },
  {
    name: 'createCustomerPayment',
    run: () => createCustomerPayment(COMPANY, {
      clientId: FOREIGN, paymentDate: '2026-09-10', totalAmount: 100,
      allocations: [{ invoiceId: '44444444-4444-4444-8444-444444444444', amount: 100 }],
    }, USER),
  },
  {
    name: 'createPracticeClient',
    run: () => createPracticeClient(COMPANY, {
      legalName: 'Acme Pty Ltd', billingModel: 'hourly',
      status: 'active', linkCustomerId: FOREIGN,
    }),
  },
];

/** The update arms need their own row-exists read before the fence. */
const UPDATE_CASES: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: 'updateQuote',
    run: () => updateQuote(COMPANY, '55555555-5555-4555-8555-555555555555', {
      clientId: FOREIGN, customerName: 'Acme',
      lines: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
    }),
  },
  {
    name: 'updateSalesOrder',
    run: () => updateSalesOrder(COMPANY, '55555555-5555-4555-8555-555555555555', {
      customer_id: FOREIGN,
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
    }),
  },
  {
    name: 'updatePracticeClient',
    run: () => updatePracticeClient(COMPANY, '55555555-5555-4555-8555-555555555555', {
      linkCustomerId: FOREIGN,
    }),
  },
];

describe('R-067 — a foreign customer id is refused before the first write', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    mockSql.mockClear();
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      return Promise.resolve([]);
    });
  });

  it.each(CASES)('$name refuses and writes nothing', async ({ run }) => {
    await expect(run()).rejects.toBeInstanceOf(CustomerNotInCompanyError);
    expect(sqlTexts).toHaveLength(1);
    expect(sqlTexts[0]).toContain('FROM customers');
    expect(writeStatements()).toEqual([]);
  });

  it.each(CASES)('$name proceeds past the fence for an own-tenant customer', async ({ run }) => {
    let call = 0;
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      // The ownership read is first on every one of these paths.
      return Promise.resolve(call++ === 0 ? [{ ok: 1 }] : []);
    });
    await run().catch(() => undefined);
    expect(sqlTexts.length).toBeGreaterThan(1);
  });
});

describe('R-067 — the update arms fence the id too', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    mockSql.mockClear();
  });

  it.each(UPDATE_CASES)('$name refuses and writes nothing', async ({ run }) => {
    // The row-exists / draft-status read comes first on these paths; make it
    // succeed so the call reaches the fence rather than early-returning.
    let call = 0;
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      call += 1;
      if (call === 1) {
        return Promise.resolve([{
          id: '55555555-5555-4555-8555-555555555555', status: 'draft',
          quote_number: 'QUO-00001', order_number: 'SO-00001', client_id: null,
          customer_id: null, lines: [], items: [],
        }]);
      }
      return Promise.resolve([]);
    });
    await expect(run()).rejects.toBeInstanceOf(CustomerNotInCompanyError);
    expect(writeStatements()).toEqual([]);
    expect(sqlTexts[sqlTexts.length - 1]).toContain('FROM customers');
  });
});

describe('R-067 — a recurring template carries a caller-supplied id in opaque JSON', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    mockSql.mockClear();
  });

  it('executeRecurring refuses the foreign client_id before minting the invoice', async () => {
    // The template row itself is company-scoped; its templateData is not — the
    // id inside it was supplied by whoever saved the template.
    let call = 0;
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      call += 1;
      if (call === 1) {
        return Promise.resolve([{
          id: '66666666-6666-4666-8666-666666666666',
          company_id: COMPANY,
          name: 'Monthly retainer',
          entity_type: 'customer_invoice',
          template_data: { clientId: FOREIGN, subtotal: 100, totalAmount: 115 },
          frequency: 'monthly',
          next_run_date: '2026-10-01',
          last_run_date: null,
          is_active: true,
          auto_post: false,
          created_by: USER,
          created_at: '2026-09-01T00:00:00.000Z',
        }]);
      }
      return Promise.resolve([]);
    });

    await expect(executeRecurring(COMPANY, '66666666-6666-4666-8666-666666666666', USER))
      .rejects.toBeInstanceOf(CustomerNotInCompanyError);
    expect(writeStatements()).toEqual([]);
    expect(sqlTexts[sqlTexts.length - 1]).toContain('FROM customers');
  });
});
