/**
 * `cancelCustomerPayment` (the receipts screen's Cancel) asks the receipt credit refusal (ar/customerVoidCredit,
 * 2026-11-14): a cancel that would take the customer's running on-account credit below zero — a refund already
 * returned the receipt's unapplied cash — is refused before any write, the customer row taken (tried) after the
 * receipt row and before the invoices and the journal. Real-ledger proof: tests/integration/ar-receipt-void-after-refund.
 * Mock setup shared with customerPaymentLockOrder.test.ts (the real `lockCustomerPaymentForUpdate` and credit SQL run).
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
// D8: the journal reversed is its chain head (real-ledger proof: tests/integration/d8-r4-matrix, M-RCPT); here, itself.
// D8 round 6: the bank leg is locked before the receipt (real-ledger proof: tests/integration/d8-r6-receipt-bank-line).
vi.mock('@/modules/accounting/services/ar/receiptBankLeg', () => ({
  lockReceiptBankLeg: vi.fn(async () => ({ journalId: 'dddddddd-0000-4000-8000-dddddddddddd', leg: {
    alreadyReversed: false, reverseId: 'dddddddd-0000-4000-8000-dddddddddddd', bankLineIds: [], seenLineIds: [], allocatedLineIds: [],
  } })),
}));
vi.mock('@/modules/accounting/services/ap/paymentJournalReversal', () => ({
  assertSameJournal: vi.fn(),
  lockJournalAndUnmatch: vi.fn(async () => undefined),
  voidViaBankAllocation: vi.fn(async () => false),
}));

vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  getCustomerPaymentById: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getCustomerPaymentById } from '@/modules/accounting/services/ar/customerPaymentService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

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

/** The receipt-invoice lock read (AR audit B1): every invoice open for R1 000, as locked. */
const lockedInvoices = () => [LOW_INVOICE, HIGH_INVOICE].map((id) => ({
  id, invoice_number: `INV-${id.slice(0, 2)}`, currency_code: 'ZAR', status: 'approved', deleted_at: null,
  total_amount: '1000.00', amount_paid: '0.00',
}));
const isInvoiceLock = (text: string) => /FROM customer_invoices[\s\S]*FOR UPDATE OF ci/i.test(text);

const indexOf = (texts: string[], re: RegExp) => texts.findIndex((t) => re.test(t));
const PAYMENT_LOCK = /FROM customer_payments[\s\S]*FOR UPDATE OF cp/i;

describe('cancelCustomerPayment — the receipt credit refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reverseJournalEntry).mockResolvedValue({ id: 'je-rev' } as never);
  });

  /** A receipt with R100 unapplied whose customer's running credit after the cancel reads `after` (2026-11-14). */
  function recordSqlWithCredit(after: number): string[] {
    const texts: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      texts.push(text);
      if (/cp\.client_id IS NOT NULL/.test(text)) return Promise.resolve([{ id: PAYMENT_ID, customer_id: 'cust', remainder: 100 }]);
      if (/WITH gone AS/.test(text)) {
        return Promise.resolve([
          { d: '2026-05-01', amount: 100, removed: 100, lowers: 100, others: 0, customer_name: 'Acme' },
          { d: '2026-05-02', amount: after, removed: 0, lowers: 0, others: after, customer_name: 'Acme' },
        ]);
      }
      return Promise.resolve(isInvoiceLock(text) ? lockedInvoices() : [{ id: PAYMENT_ID, status: 'x' }]);
    });
    return texts;
  }

  it('takes the customer (tried) after the receipt and its invoices, before any write, and asks its credit there', async () => {
    mockGetPayment.mockResolvedValue(payment());
    const texts = recordSqlWithCredit(0);
    await cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID);
    const lock = indexOf(texts, PAYMENT_LOCK);
    const invoiceLock = indexOf(texts, /FROM customer_invoices[\s\S]*FOR UPDATE OF ci/i);
    const customer = indexOf(texts, /FROM customers c[\s\S]*SKIP LOCKED/);
    const credit = indexOf(texts, /WITH gone AS/);
    const invoices = indexOf(texts, /UPDATE customer_invoices/i);
    expect(invoiceLock).toBeGreaterThan(lock);
    expect(customer).toBeGreaterThan(invoiceLock); // payments → invoices → customers
    expect(customer).toBeGreaterThan(lock);
    expect(credit).toBeGreaterThan(customer);
    expect(invoices).toBeGreaterThan(credit);
  });

  it('refuses a cancel a refund has already spent, before any invoice, journal or receipt write', async () => {
    mockGetPayment.mockResolvedValue(payment());
    const texts = recordSqlWithCredit(-100);
    await expect(cancelCustomerPayment(COMPANY_ID, PAYMENT_ID, USER_ID))
      .rejects.toMatchObject({ code: 'RECEIPT_REFUSED', reason: 'credit_ceiling' });
    expect(texts.filter((t) => /UPDATE customer_(invoices|payments)/i.test(t))).toEqual([]);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });
});
