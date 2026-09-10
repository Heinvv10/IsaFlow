/**
 * `confirmSupplierInvoiceMatch` — the decisions the supplier arm of
 * bank-match-confirm makes BEFORE it writes, and the one hand-off it makes
 * after.
 *
 * The real posting path is covered by the K-074 integration tests against a
 * live database. What is pinned here is the seam: the validation is run exactly
 * once and its result is handed to the write, so the two cannot disagree and
 * the request transaction does not re-read the line, its status, the period and
 * the bill plan a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
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

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VALIDATION = { bankTxId: 'tx-1', paymentAmount: 600, supplierId: 'sup-1' };
const validateBankSupplierPayment = vi.fn(async () => VALIDATION);
const applyBankLineToSupplierInvoices = vi.fn(async () => ({
  supplierPaymentId: 'sp-1', paymentNumber: 'SP-0001', allocatedTotal: 600,
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  validateBankSupplierPayment: (...a: unknown[]) => validateBankSupplierPayment(...(a as [])),
  applyBankLineToSupplierInvoices: (...a: unknown[]) => applyBankLineToSupplierInvoices(...(a as [])),
}));

import { confirmSupplierInvoiceMatch } from '@/modules/accounting/services/bank/confirmSupplierMatch';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import {
  planSupplierAllocationLines,
  type SupplierAllocationInput,
} from '@/modules/accounting/services/ap/supplierAllocationLines';

const COMPANY = 'company-1';
const TX = 'tx-1';
const BILL = 'bill-1';
const USER = 'user-1';

/**
 * The bank line's own `FOR UPDATE` read, which is now the arm's FIRST statement
 * — see the lock-order note in `confirmSupplierMatch.ts`. Every fixture below
 * enqueues it before the bill, because a queue that starts at the bill would
 * hand the bill row to the lock and the lock's row to the bill.
 */
function bankLine() {
  sqlMock.mockResolvedValueOnce([{ id: TX, status: 'imported' }]);
}

/** One bill, `total` owed, `paid` already settled, behind its bank line. */
function bill(total: number, paid = 0) {
  bankLine();
  sqlMock.mockResolvedValueOnce([{ id: BILL, total_amount: String(total), amount_paid: String(paid) }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  validateBankSupplierPayment.mockResolvedValue(VALIDATION);
  applyBankLineToSupplierInvoices.mockResolvedValue({
    supplierPaymentId: 'sp-1', paymentNumber: 'SP-0001', allocatedTotal: 600,
  });
});

describe('confirmSupplierInvoiceMatch', () => {
  it('validates once and hands that same result to the write', async () => {
    bill(600);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);

    expect(outcome).toEqual({
      ok: true, supplierPaymentId: 'sp-1', paymentNumber: 'SP-0001', allocated: 600,
    });
    expect(validateBankSupplierPayment).toHaveBeenCalledTimes(1);
    // THE POINT: the write is given the validation rather than repeating it.
    // Without this the same eight reads run twice per confirm, and the second
    // pass can see a different world than the one the 4xx decision was made on.
    expect(applyBankLineToSupplierInvoices).toHaveBeenCalledWith(
      COMPANY, expect.objectContaining({ validation: VALIDATION }),
    );
  });

  it('refuses an over-payment before validating anything, naming the excess', async () => {
    bill(600);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 1000);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/R400\.00 excess/);
    expect(validateBankSupplierPayment).not.toHaveBeenCalled();
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('settles a partial payment for exactly the line', async () => {
    bill(600);
    await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 250);
    expect(validateBankSupplierPayment).toHaveBeenCalledWith(
      COMPANY, TX, [{ invoiceId: BILL, amount: 250 }],
    );
  });

  it('reports a missing bill as not_found, distinct from a refusal', async () => {
    bankLine();
    sqlMock.mockResolvedValueOnce([]);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toEqual({ ok: false, kind: 'not_found' });
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('turns a validation refusal into its message, with nothing written', async () => {
    bill(600);
    validateBankSupplierPayment.mockRejectedValueOnce(
      new SupplierPaymentRefusal('is "allocated" and cannot be allocated'),
    );
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/cannot be allocated/);
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  // The refusal's MIRROR, and the reason the class exists. Catching every throw
  // classified an infrastructure failure as the user's fault: the route answers
  // a refusal with `apiResponse.badRequest`, which passes the message straight
  // to the client, so raw Postgres text reached the browser as a 400 — a status
  // `withAuth` COMMITs — and a real fault was monitored as a client error.
  it('re-throws an infrastructure failure instead of reporting it as a refusal', async () => {
    bill(600);
    const dbError = Object.assign(
      new Error('current transaction is aborted, commands ignored until end of transaction block'),
      { code: '25P02' },
    );
    validateBankSupplierPayment.mockRejectedValueOnce(dbError);

    await expect(confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600)).rejects.toThrow(/25P02|aborted/);
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  // A refusal raised from `planSupplierAllocationLines` BENEATH the validator
  // must be classified the same way — the class is on the refusal, not on the
  // function that happens to raise it.
  //
  // The validator runs FOR REAL here (only its DB read is stubbed) so
  // `buildLine` is the thing that throws. Mocking the rejection instead would
  // have asserted nothing about `supplierAllocationLines.ts`: the test stayed
  // green with every refusal in that file still a bare `Error`.
  it('classifies a refusal raised inside planSupplierAllocationLines, not just one the validator threw', async () => {
    bill(600);
    validateBankSupplierPayment.mockImplementationOnce(
      (async (companyId: string, _txId: string, allocations: SupplierAllocationInput[]) =>
        planSupplierAllocationLines(companyId, allocations, { paymentId: null, supplierId: null })
      ) as unknown as () => Promise<typeof VALIDATION>,
    );
    // The one read `planSupplierAllocationLines` makes: the bill is cancelled,
    // which `buildLine` refuses.
    sqlMock.mockResolvedValueOnce([{
      id: BILL, invoice_number: 'INV-9', supplier_id: 'sup-1',
      total_amount: '600', amount_paid: '0', status: 'cancelled', already_allocated: 0,
    }]);

    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/INV-9 is cancelled/);
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('refuses a bill with nothing outstanding', async () => {
    bill(600, 600);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/already fully paid/i);
  });

  // MEDIUM-1 (round 7). The bill lock (`FOR UPDATE OF si`, inside
  // `fetchBillCandidates`) used to be this arm's first row lock, so the order
  // was supplier_invoices → bank_transactions while `allocateTransaction`,
  // `splitAllocateTransaction` and `reverseReconciledTransaction` all take
  // bank_transactions first. Two requests naming the same (line, bill) pair
  // from the two directions hold one row each and deadlock — 40P01, which
  // `withAuth` answers 500.
  //
  // Asserted on the SQL the arm issues, in order, because that is what the
  // canonical order in `bank/.claude.md` is a rule about. A mock of the lock
  // helper would have passed with the call left where it was.
  it('locks the bank line BEFORE it reads the bill — the canonical order', async () => {
    bill(600);
    await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);

    const texts = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(texts[0]).toMatch(/FROM bank_transactions[\s\S]*FOR UPDATE/);
    expect(texts[1]).toMatch(/FROM supplier_invoices/);
    // And the 5s budget the lock helper sets, on the request client.
    expect(mockTx.queries).toContain("SET LOCAL lock_timeout = '5s'");
  });

  // The lock is taken for its ORDER, not for the decision. A line that has
  // vanished (or belongs to another tenant) is still refused by the
  // validator's own not-found wording, which the route and the MCP tools
  // depend on — so a null from the lock must NOT become an early not_found
  // naming the bill.
  it('leaves a vanished bank line to the validator rather than reporting the bill missing', async () => {
    sqlMock.mockResolvedValueOnce([]);                 // bank line gone
    sqlMock.mockResolvedValueOnce([{ id: BILL, total_amount: '600', amount_paid: '0' }]);
    validateBankSupplierPayment.mockRejectedValueOnce(
      new SupplierPaymentRefusal(`Bank transaction ${TX} not found`),
    );
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/Bank transaction .* not found/);
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });
});
