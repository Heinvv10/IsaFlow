/**
 * Unit tests for supplierPaymentWorkflowService.processSupplierPayment
 *
 * Tenant-isolation regression guard: the bank-account resolution
 *   SELECT * FROM gl_accounts WHERE id = ${payment.bankAccountId}
 * omitted company_id. Its id then became a posted GL line in this company's
 * journal entry — so a payment carrying a bankAccountId belonging to another
 * tenant would post a journal line against a foreign company's GL account
 * (the exact cross-tenant line drift observed in real data). The fix scopes
 * the lookup by company_id so a foreign account resolves to nothing and the
 * existing `if (!bankAccount) throw` fails closed.
 *
 * All DB and collaborator calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `lockSupplierPaymentForUpdate` — the FIRST lock this path now takes — refuses
// to run outside a request transaction. Stand in for the withAuth-bound client.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    queries: [] as string[],
    client: { query: (t: string) => { mockTx.queries.push(t); return Promise.resolve(undefined); } },
  },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  // Spreading the ALS instance keeps `getStore` stubbed but loses the
  // prototype methods, so `run` — which `inRequestTx` below uses to enter a
  // request context explicitly — is restored here. The stubbed `getStore`
  // already reports a context, so running the callback directly is enough.
  return {
    ...actual,
    als: {
      ...actual.als,
      getStore: () => ({ client: mockTx.client }),
      run: <T>(_ctx: unknown, fn: () => T): T => fn(),
    },
  };
});

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-001' }),
  postJournalEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acc-payable-001' }),
}));

const getSupplierPaymentById = vi.fn();
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  getSupplierPaymentById: (...args: unknown[]) => getSupplierPaymentById(...args),
}));

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const PAYMENT_ID = 'pay-00000000-0000-0000-0000-000000000001';
const FOREIGN_BANK_ACCT = 'gl-bank-belongs-to-company-b';
const USER_ID = 'user-1';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

/**
 * `claimUnderLockTimeout` refuses to claim outside a request transaction — the
 * claim would autocommit and could not be rolled back with the posting that
 * follows it. These unit tests mock `sql`, so the client only has to exist;
 * `SET LOCAL` goes to the stub.
 */
const requestCtx = {
  client: { query: vi.fn() }, userId: USER_ID, companyId: COMPANY_A, claims: {},
} as unknown as Parameters<typeof als.run>[0];
const inRequestTx = <T>(fn: () => Promise<T>): Promise<T> => als.run(requestCtx, fn);


function makeApprovedPayment() {
  return {
    id: PAYMENT_ID,
    paymentNumber: 'PAY-0001',
    supplierId: 'sup-1',
    paymentDate: '2026-05-01',
    totalAmount: 1000,
    paymentMethod: 'eft',
    bankAccountId: FOREIGN_BANK_ACCT,
    status: 'approved',
    allocations: [],
  };
}

/** A processed supplier_payments row for the final mapPaymentRow call. */
function makeProcessedRow() {
  return {
    id: PAYMENT_ID,
    payment_number: 'PAY-0001',
    supplier_id: 'sup-1',
    payment_date: '2026-05-01',
    total_amount: '1000',
    payment_method: 'eft',
    status: 'processed',
    created_by: USER_ID,
    gl_journal_entry_id: 'je-001',
  };
}

describe('processSupplierPayment — bank account tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSupplierPaymentById.mockResolvedValue(makeApprovedPayment());
  });

  it('scopes the bank-account lookup to companyId', async () => {
    // The merged path takes BOTH: call 0 = the payment row lock; call 1 = the
    // status-predicated CLAIM; call 2 = bank account lookup;
    // call 3 = UPDATE supplier_payments SET gl_journal_entry_id RETURNING *.
    // A non-empty claim result is what stops the path refusing at that step.
    sqlMock
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ id: FOREIGN_BANK_ACCT }])
      .mockResolvedValueOnce([makeProcessedRow()]);

    await inRequestTx(() => processSupplierPayment(COMPANY_A, PAYMENT_ID, USER_ID));

    const bankLookup = sqlMock.mock.calls.find((args) =>
      /FROM\s+gl_accounts/i.test((args[0] as readonly string[]).join(' ')),
    );
    expect(bankLookup, 'bank account lookup query not found').toBeDefined();

    const text = (bankLookup![0] as readonly string[]).join(' ');
    expect(text).toMatch(/company_id/i);
    expect(bankLookup!.slice(1)).toContain(COMPANY_A);
    expect(bankLookup!.slice(1)).not.toContain(COMPANY_B);
  });

  it('locks the payment before it touches supplier_invoices', async () => {
    // Canonical order (bank/.claude.md): payment (2) -> invoices (3). This path
    // used to write the invoice loop first and flip the payment last, the
    // inverse of `planSupplierPaymentApplication`, which locks the payment and
    // THEN the bills through `fetchBillCandidates`.
    // An allocation, or the invoice loop never runs and the order assertion
    // passes on an absent statement.
    getSupplierPaymentById.mockResolvedValue({
      ...makeApprovedPayment(),
      allocations: [{ invoiceId: 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb', amountAllocated: 1000 }],
    });
    sqlMock.mockResolvedValue([makeProcessedRow()]);

    await processSupplierPayment(COMPANY_A, PAYMENT_ID, USER_ID);

    const texts = sqlMock.mock.calls.map((args) => (args[0] as readonly string[]).join(' '));
    const lock = texts.findIndex((t) => /FROM supplier_payments[\s\S]*FOR UPDATE OF sp/i.test(t));
    const invoices = texts.findIndex((t) => /UPDATE supplier_invoices/i.test(t));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(invoices).toBeGreaterThan(lock);
  });

  it('fails closed when the bank account does not belong to the company', async () => {
    // Lock, then claim wins, then the scoped lookup returns no row (foreign
    // account filtered out by company_id).
    sqlMock
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([{ id: PAYMENT_ID }])
      .mockResolvedValueOnce([]);

    await expect(inRequestTx(() => processSupplierPayment(COMPANY_A, PAYMENT_ID, USER_ID))).rejects.toThrow(
      /bank account not found/i,
    );
  });
});
