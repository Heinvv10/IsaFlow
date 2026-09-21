/**
 * `confirmCustomerPayment` / `cancelCustomerPayment` — the AR half of the
 * canonical lock order in `src/modules/accounting/services/bank/.claude.md`:
 * (1) bank_transactions, (2) customer_payments, (3) customer_invoices,
 * (4) gl_journal_entries.
 *
 * `cancelCustomerPayment` is the twin of `voidSupplierPayment` and carried the
 * same inversion: it reversed the pre-existing journal FIRST, then rolled the
 * invoices back, and flipped the payment LAST — the exact inverse of
 * `voidPaymentDocument`, which reaches the same receipt through
 * `unwindOnePayment` after locking payment then invoices then GL. Two agents
 * undoing one receipt from its two entrances held a row each; Postgres killed
 * one with 40P01 and `withAuth` answered the survivor's victim a 500.
 *
 * `confirmCustomerPayment` had the payment-vs-invoice half of it: the invoice
 * loop ran before the status flip, inverting `planReceiptApplication`, which
 * locks the receipt and THEN the invoices through `fetchInvoiceCandidates`.
 * The journal it POSTS is created in the same transaction, so no other
 * transaction can contend for that row and it is not part of the ordering.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// The real `lockCustomerPaymentForUpdate` runs here — it is the statement under
// test — and it refuses to run outside a request transaction.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    queries: [] as string[],
    client: { query: (t: string) => { mockTx.queries.push(t); return Promise.resolve(undefined); } },
  },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  return { ...actual, als: { ...actual.als, getStore: () => ({ client: mockTx.client }) } };
});

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d ?? ''),
  };
});

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-new' }),
  postJournalEntry: vi.fn().mockResolvedValue(undefined),
  reverseJournalEntry: vi.fn().mockResolvedValue({ id: 'je-rev' }),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acc-ar' }),
}));

vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  getCustomerPaymentById: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getCustomerPaymentById } from '@/modules/accounting/services/ar/customerPaymentService';
import {
  confirmCustomerPayment,
  cancelCustomerPayment,
} from '@/modules/accounting/services/ar/customerPaymentAllocationService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockGetPayment = getCustomerPaymentById as unknown as MockedFunction<
  (c: string, i: string) => Promise<Record<string, unknown> | null>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const PAYMENT_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const JOURNAL_ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';
const LOW_INVOICE = '11111111-0000-4000-8000-111111111111';
const HIGH_INVOICE = '99999999-0000-4000-8000-999999999999';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    paymentNumber: 'RCP-0001',
    paymentDate: '2026-05-01',
    totalAmount: 100,
    bankAccountId: undefined,
    status: 'confirmed',
    glJournalEntryId: JOURNAL_ID,
    allocations: [{ invoiceId: LOW_INVOICE, amountAllocated: 100 }],
    ...overrides,
  };
}

/** Statement texts in the order the service issued them. */
function recordSql(): string[] {
  const texts: string[] = [];
  mockSql.mockImplementation((strings: TemplateStringsArray) => {
    texts.push((strings as unknown as string[]).join('?'));
    return Promise.resolve([{ id: PAYMENT_ID, status: 'x' }]);
  });
  return texts;
}

const indexOf = (texts: string[], re: RegExp) => texts.findIndex((t) => re.test(t));
const PAYMENT_LOCK = /FROM customer_payments[\s\S]*FOR UPDATE OF cp/i;

describe('cancelCustomerPayment — canonical lock order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([{ id: PAYMENT_ID, status: 'cancelled' }]);
    vi.mocked(reverseJournalEntry).mockResolvedValue({ id: 'je-rev' } as never);
  });

  it('takes the payment, then the invoices, then the journal', async () => {
    mockGetPayment.mockResolvedValue(payment());
    const texts = recordSql();

    await cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID, 'oops');

    const lock = indexOf(texts, PAYMENT_LOCK);
    const invoices = indexOf(texts, /UPDATE customer_invoices/i);
    expect(lock, 'the receipt row must be locked first').toBeGreaterThanOrEqual(0);
    expect(invoices).toBeGreaterThan(lock);
    // The journal reversal is a collaborator, so its position is measured
    // against the invoice roll-back it must now follow.
    const reverseCallOrder = vi.mocked(reverseJournalEntry).mock.invocationCallOrder[0]!;
    const invoiceCallOrder = mockSql.mock.invocationCallOrder[invoices]!;
    expect(reverseCallOrder).toBeGreaterThan(invoiceCallOrder);
  });

  it('rolls invoices back in ascending id, not capture order', async () => {
    mockGetPayment.mockResolvedValue(payment({
      allocations: [
        { invoiceId: HIGH_INVOICE, amountAllocated: 40 },
        { invoiceId: LOW_INVOICE, amountAllocated: 60 },
      ],
    }));
    const seen: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/UPDATE customer_invoices/i.test(text)) seen.push(String(values[values.length - 2]));
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });

    await cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(seen).toEqual([LOW_INVOICE, HIGH_INVOICE]);
  });

  it('refuses a receipt that does not exist for this tenant, before any read', async () => {
    mockSql.mockResolvedValue([]);

    await expect(cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toThrow(/not found/i);
    expect(mockGetPayment).not.toHaveBeenCalled();
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses a non-confirmed receipt without reversing anything', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'draft' }));

    await expect(cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toThrow(/draft/i);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('runs inside a savepoint — the route 400s everything and withAuth COMMITs a 4xx', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'draft' }));
    await cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID).catch(() => undefined);

    expect(withSavepoint).toHaveBeenCalledWith('cancel_customer_payment', expect.any(Function));
  });
});

describe('confirmCustomerPayment — canonical lock order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([{ id: PAYMENT_ID, status: 'confirmed' }]);
  });

  it('locks the receipt before it touches customer_invoices', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'draft' }));
    const texts = recordSql();

    await confirmCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    const lock = indexOf(texts, PAYMENT_LOCK);
    const invoices = indexOf(texts, /UPDATE customer_invoices/i);
    const flip = indexOf(texts, /UPDATE customer_payments\s*\?*\s*SET status = 'confirmed'/i);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(invoices).toBeGreaterThan(lock);
    expect(flip).toBeGreaterThan(invoices);
  });

  it('applies invoices in ascending id, not capture order', async () => {
    mockGetPayment.mockResolvedValue(payment({
      status: 'draft',
      allocations: [
        { invoiceId: HIGH_INVOICE, amountAllocated: 40 },
        { invoiceId: LOW_INVOICE, amountAllocated: 60 },
      ],
    }));
    const seen: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/UPDATE customer_invoices/i.test(text)) seen.push(String(values[values.length - 2]));
      return Promise.resolve([{ id: PAYMENT_ID, status: 'confirmed' }]);
    });

    await confirmCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(seen).toEqual([LOW_INVOICE, HIGH_INVOICE]);
  });

  it('runs inside a savepoint', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'confirmed' }));
    await confirmCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID).catch(() => undefined);

    expect(withSavepoint).toHaveBeenCalledWith('confirm_customer_payment', expect.any(Function));
  });
});
