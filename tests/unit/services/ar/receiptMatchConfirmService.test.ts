/**
 * receiptMatchConfirmService — allocating an imported bank line to the customer
 * invoices it settles.
 *
 * Moved here from receiptMatchService.test.ts when the write half was split out
 * and WIDENED from one invoice to many. One receipt routinely pays several
 * invoices, and the single-invoice form left the rest of the bank line sitting
 * on the AR control account with nothing recording what it was for.
 *
 * What is pinned:
 *
 *  - **Every refusal happens BEFORE allocateTransaction.** That is what lets an
 *    MCP handler answer with a `toolError` while nothing has been written; a
 *    refusal returned after the journal posted would free the idempotency key
 *    for a retry that posts a second one.
 *  - **The journal is the FULL bank line, and allocating less is allowed.** The
 *    remainder is a real unapplied receipt, not an error — allocating MORE is
 *    refused, because the invoices would be credited with cash the journal
 *    never received.
 *  - **An already-allocated bank line is refused**, not allocated twice.
 *  - **A missing customer_payments row THROWS.** allocateTransaction skips its
 *    payment INSERT when it cannot resolve a uuid-shaped user; without that row
 *    the receipt would post to the control account and attach to nothing, which
 *    is the exact state this service exists to prevent.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// `fetchInvoiceCandidates` refuses to run outside a request transaction — its
// `FOR UPDATE` would be released at the end of its own statement and protect
// nothing. Stand in for the withAuth-bound client.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    queries: [] as string[],
    present: true,
    client: { query: (t: string) => { mockTx.queries.push(t); return Promise.resolve(undefined); } },
  },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  return {
    ...actual,
    als: {
      ...actual.als,
      getStore: () => (mockTx.present ? { client: mockTx.client } : undefined),
    },
  };
});

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankMatchDbQueries', () => ({
  fetchBankTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  getBankTransactionStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({
  planReceiptApplication: vi.fn(),
  applyReceiptPlan: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { fetchBankTransaction } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  planReceiptApplication,
  applyReceiptPlan,
} from '@/modules/accounting/services/ar/receiptApplicationService';
import {
  validateBankReceiptApplication,
  confirmReceiptMatch,
} from '@/modules/accounting/services/ar/receiptMatchConfirmService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INV_A = '44444444-4444-4444-8444-444444444444';
const INV_B = '55555555-5555-4555-8555-555555555555';
const TX = '66666666-6666-4666-8666-666666666666';
const USER = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown>;
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<Row[]>>;

function line(id: string, amount: number) {
  return {
    invoiceId: id,
    invoiceNumber: id === INV_A ? 'INV0001' : 'INV0002',
    amount,
    outstandingBefore: amount,
    outstandingAfter: 0,
    statusBefore: 'approved',
    statusAfter: 'paid',
  };
}

/** The invoice-candidate query planAllocationLines runs. */
function invoiceRows(rows: Row[]): void {
  sqlMock.mockResolvedValueOnce(rows);
}
function invoiceRow(id: string, over: Row = {}): Row {
  return {
    id,
    invoice_number: id === INV_A ? 'INV0001' : 'INV0002',
    owner_id: CUSTOMER,
    total_amount: '600.00',
    amount_paid: '0',
    status: 'approved',
    already_allocated: '0',
    ...over,
  };
}

function goodTx(over: Record<string, unknown> = {}) {
  return {
    id: TX,
    amount: 1000,
    transactionDate: '2026-03-01',
    description: 'ACME PAYMENT',
    reference: 'REF1',
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPeriodStatusForDate).mockResolvedValue('open');
});

describe('validateBankReceiptApplication', () => {
  it('accepts an under-allocation and reports the remainder as unapplied', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    invoiceRows([invoiceRow(INV_A), invoiceRow(INV_B)]);

    const v = await validateBankReceiptApplication(COMPANY, TX, [
      { invoiceId: INV_A, amount: 600 },
      { invoiceId: INV_B, amount: 250 },
    ]);
    expect(v.receiptAmount).toBe(1000);
    expect(v.allocatedTotal).toBe(850);
    expect(v.unappliedRemainder).toBe(150);
    expect(v.customerId).toBe(CUSTOMER);
  });

  it('REFUSES allocating more than the bank line', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx({ amount: 500 }));
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    invoiceRows([invoiceRow(INV_A)]);
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [{ invoiceId: INV_A, amount: 600 }]),
    ).rejects.toThrow(/cash the journal never received/i);
  });

  it('refuses a payment (money out) with the tool that handles it', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx({ amount: -400 }));
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/money OUT/i);
  });

  it('REFUSES AN ALREADY-ALLOCATED LINE rather than posting a second journal', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated');
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/cannot be allocated/i);
  });

  it('reports an unknown transaction the same way as a cross-tenant one', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(null);
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/not found/i);
  });

  it('REFUSES A CLOSED PERIOD BEFORE THE JOURNAL IS INSERTED', async () => {
    // postJournalEntry raises ClosedFiscalPeriodError, but only after
    // createJournalEntry has INSERTed the draft — so the failure lands after
    // the first write and reaches the agent as a generic failure. Answered
    // from a read here, it is a refusal with a remedy in it.
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    vi.mocked(getPeriodStatusForDate).mockResolvedValue('closed');
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/is closed\. Re-open it/i);
  });

  it('refuses a date no fiscal period covers, naming the OTHER remedy', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    vi.mocked(getPeriodStatusForDate).mockResolvedValue('no_period');
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [{ invoiceId: INV_A, amount: 100 }]),
    ).rejects.toThrow(/Create the fiscal year first/i);
  });

  it('refuses invoices belonging to two different customers', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    invoiceRows([
      invoiceRow(INV_A),
      invoiceRow(INV_B, { owner_id: '2b222222-2222-4222-8222-222222222222' }),
    ]);
    await expect(
      validateBankReceiptApplication(COMPANY, TX, [
        { invoiceId: INV_A, amount: 100 },
        { invoiceId: INV_B, amount: 100 },
      ]),
    ).rejects.toThrow(/different customer/i);
  });
});

describe('confirmReceiptMatch', () => {
  function primeValid(txAmount = 1000) {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx({ amount: txAmount }));
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    invoiceRows([invoiceRow(INV_A)]);
  }

  it('posts ONE journal for the whole line and then applies the allocations', async () => {
    primeValid();
    vi.mocked(allocateTransaction).mockResolvedValue({ journalEntryId: 'je-1' } as never);
    sqlMock.mockResolvedValueOnce([{ id: PAYMENT }]);
    const plan = {
      paymentId: PAYMENT, paymentNumber: 'RCP1', customerId: CUSTOMER,
      paymentTotal: 1000, allocatedBefore: 0, allocatedAfter: 600,
      unappliedBefore: 1000, unappliedAfter: 400,
      paymentStatusBefore: 'confirmed', paymentStatusAfter: 'confirmed',
      lines: [line(INV_A, 600)], postsJournal: false as const,
    };
    vi.mocked(planReceiptApplication).mockResolvedValue(plan);
    vi.mocked(applyReceiptPlan).mockResolvedValue(plan);

    const result = await confirmReceiptMatch(COMPANY, {
      bankTxId: TX, userId: USER, allocations: [{ invoiceId: INV_A, amount: 600 }],
      postingAgent: 'mcp:x:v1',
    });

    expect(allocateTransaction).toHaveBeenCalledTimes(1);
    // allocType, entityId, invoiceId and the posting-agent stamp.
    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[5]).toBe('customer');
    expect(call[6]).toBe(CUSTOMER);
    expect(call[11]).toBe(INV_A);
    expect(call[12]).toEqual({ postingAgent: 'mcp:x:v1' });
    expect(applyReceiptPlan).toHaveBeenCalledTimes(1);
    expect(result.journalEntryId).toBe('je-1');
    expect(result.unappliedRemainder).toBe(400);
  });

  it('DOES NOT ALLOCATE when validation refuses', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(goodTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated');
    await expect(
      confirmReceiptMatch(COMPANY, {
        bankTxId: TX, userId: USER, allocations: [{ invoiceId: INV_A, amount: 100 }],
      }),
    ).rejects.toThrow(/cannot be allocated/i);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('THROWS when no customer payment row was created, so the journal unwinds', async () => {
    primeValid();
    vi.mocked(allocateTransaction).mockResolvedValue({ journalEntryId: 'je-1' } as never);
    sqlMock.mockResolvedValueOnce([]); // allocateTransaction skipped its INSERT
    await expect(
      confirmReceiptMatch(COMPANY, {
        bankTxId: TX, userId: USER, allocations: [{ invoiceId: INV_A, amount: 600 }],
      }),
    ).rejects.toThrow(/no customer payment record was created/i);
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  it('scopes the customer_payments lookup to the company', async () => {
    primeValid();
    vi.mocked(allocateTransaction).mockResolvedValue({ journalEntryId: 'je-1' } as never);
    sqlMock.mockResolvedValueOnce([{ id: PAYMENT }]);
    const plan = {
      paymentId: PAYMENT, paymentNumber: 'RCP1', customerId: CUSTOMER,
      paymentTotal: 1000, allocatedBefore: 0, allocatedAfter: 600,
      unappliedBefore: 1000, unappliedAfter: 400,
      paymentStatusBefore: 'confirmed', paymentStatusAfter: 'confirmed',
      lines: [line(INV_A, 600)], postsJournal: false as const,
    };
    vi.mocked(planReceiptApplication).mockResolvedValue(plan);
    vi.mocked(applyReceiptPlan).mockResolvedValue(plan);
    await confirmReceiptMatch(COMPANY, {
      bankTxId: TX, userId: USER, allocations: [{ invoiceId: INV_A, amount: 600 }],
    });
    const lookup = sqlMock.mock.calls.find(
      (c) => (c[0] as string[]).join('?').includes('FROM customer_payments'),
    )!;
    expect(lookup.slice(1)).toContain(COMPANY);
  });
});
