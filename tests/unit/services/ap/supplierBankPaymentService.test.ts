/**
 * validateBankSupplierPayment — the AP mirror of validateBankReceiptApplication.
 *
 * These exist so the two bank paths cannot diverge. Every guard tested on the
 * AR side is tested here on the same terms: an agent that has learned one tool
 * must get the same refusals, for the same reasons, from the other.
 *
 * The AP-specific half: this path creates the `supplier_payments` row that
 * `allocateTransaction(allocType='supplier')` never creates. Without it there
 * is no payment document, and a bill can never be reconciled to the cash that
 * paid it — which is how 17 Brightsphere bills read as open against a Sage book
 * showing every one paid.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// `fetchInvoiceCandidates` / `fetchBillCandidates` refuse to run outside a
// request transaction — their `FOR UPDATE` would be released at the end of its
// own statement and protect nothing. Stand in for the withAuth-bound client so
// the guards under test are exercised, and so the 5s `SET LOCAL lock_timeout`
// is observable.
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
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  resolveUserUuid: vi.fn(async (id: string) => id),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', () => ({
  planSupplierPaymentApplication: vi.fn(),
  applySupplierPaymentPlan: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { fetchBankTransaction } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { validateBankSupplierPayment } from '@/modules/accounting/services/ap/supplierBankPaymentService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const BILL = '44444444-4444-4444-8444-444444444444';
const TX = '66666666-6666-4666-8666-666666666666';

type Row = Record<string, unknown>;
const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<Row[]>>;

function billRow(over: Row = {}): Row {
  return {
    id: BILL,
    invoice_number: 'BILL0001',
    supplier_id: SUPPLIER,
    total_amount: '600.00',
    amount_paid: '0',
    status: 'approved',
    already_allocated: '0',
    ...over,
  };
}
function outgoingTx(over: Record<string, unknown> = {}) {
  return {
    id: TX, amount: -1000, transactionDate: '2026-03-01',
    description: 'EFT TO ACME', reference: 'REF1', ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPeriodStatusForDate).mockResolvedValue('open');
});

describe('validateBankSupplierPayment', () => {
  it('accepts an under-allocation and reports the remainder', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    sqlMock.mockResolvedValueOnce([billRow()]);

    const v = await validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 600 }]);
    // The bank line's ABSOLUTE value: money out is negative on the row.
    expect(v.paymentAmount).toBe(1000);
    expect(v.allocatedTotal).toBe(600);
    expect(v.unappliedRemainder).toBe(400);
    expect(v.supplierId).toBe(SUPPLIER);
  });

  it('REFUSES allocating more than the bank line', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx({ amount: -500 }));
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    sqlMock.mockResolvedValueOnce([billRow()]);
    await expect(validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 600 }]))
      .rejects.toThrow(/cash that never left the bank/i);
  });

  it('refuses a RECEIPT (money in) and names the tool that handles it', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx({ amount: 400 }));
    await expect(validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 100 }]))
      .rejects.toThrow(/money IN.*apply_receipt_to_invoice/is);
  });

  it('REFUSES AN ALREADY-ALLOCATED LINE rather than posting a second journal', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated');
    await expect(validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 100 }]))
      .rejects.toThrow(/cannot be allocated/i);
  });

  it('REFUSES A CLOSED PERIOD BEFORE THE JOURNAL IS INSERTED', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    vi.mocked(getPeriodStatusForDate).mockResolvedValue('closed');
    await expect(validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 100 }]))
      .rejects.toThrow(/is closed\. Re-open it/i);
  });

  it('refuses a date no fiscal period covers, naming the OTHER remedy', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    vi.mocked(getPeriodStatusForDate).mockResolvedValue('no_period');
    await expect(validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 100 }]))
      .rejects.toThrow(/Create the fiscal year first/i);
  });

  it('reports an unknown transaction the same way as a cross-tenant one', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(null);
    await expect(validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 100 }]))
      .rejects.toThrow(/not found/i);
  });

  it('refuses bills belonging to two different suppliers', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    sqlMock.mockResolvedValueOnce([
      billRow(),
      billRow({ id: '4b444444-4444-4444-8444-444444444444', invoice_number: 'BILL0002',
        supplier_id: '2b222222-2222-4222-8222-222222222222' }),
    ]);
    await expect(validateBankSupplierPayment(COMPANY, TX, [
      { invoiceId: BILL, amount: 100 },
      { invoiceId: '4b444444-4444-4444-8444-444444444444', amount: 100 },
    ])).rejects.toThrow(/different supplier/i);
  });

  it('scopes the bill lookup to the company', async () => {
    vi.mocked(fetchBankTransaction).mockResolvedValue(outgoingTx());
    vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
    sqlMock.mockResolvedValueOnce([billRow()]);
    await validateBankSupplierPayment(COMPANY, TX, [{ invoiceId: BILL, amount: 100 }]);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain(COMPANY);
  });
});
