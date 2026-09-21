// RED phase — written before implementation (A–Z programme P2.1, audit W4)
/**
 * voidSupplierPayment — the explicit reversal path for PROCESSED supplier
 * payments (audit W4: "processed supplier payments have no reverse/cancel —
 * mistaken entries can't be cleanly removed").
 *
 * Smallest correct fix: void = reverse the payment's GL journal (metadata
 * semantics), un-apply its allocations (amount_paid rolls back, invoice
 * status recomputed), and set the payment to the existing 'cancelled'
 * status (no schema change). Only 'processed' payments are voidable —
 * reconciled ones are anchored to a bank rec and must be un-reconciled first.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// `lockSupplierPaymentForUpdate` refuses to run outside a request transaction —
// its `FOR UPDATE` would be released at the end of its own statement and
// protect nothing. Stand in for the withAuth-bound client so the ORDER under
// test is actually exercised.
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

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  getSupplierPaymentById: vi.fn(),
}));

// The bank leg and the journal lock are DB-backed (`paymentJournalReversal.ts`)
// and proved against PostgreSQL in k064-bank-leg-and-void; here they only need
// to report where in the sequence they run. `assertSameJournal` stays real.
vi.mock('@/modules/accounting/services/ap/paymentJournalReversal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/ap/paymentJournalReversal')>()),
  lockPaymentBankLeg: vi.fn(),
  lockJournalAndUnmatch: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSupplierPaymentById } from '@/modules/accounting/services/ap/supplierPaymentService';
import {
  lockJournalAndUnmatch, lockPaymentBankLeg,
} from '@/modules/accounting/services/ap/paymentJournalReversal';
import {
  SupplierPaymentNotFoundError, voidSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockReverse = reverseJournalEntry as unknown as MockedFunction<
  (c: string, i: string, u: string) => Promise<{ id: string }>
>;
const mockGetPayment = getSupplierPaymentById as unknown as MockedFunction<
  (c: string, i: string) => Promise<Record<string, unknown> | null>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const PAYMENT_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const JOURNAL_ID = 'dddddddd-0000-4000-8000-dddddddddddd';
const INVOICE_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    status: 'processed',
    totalAmount: 115,
    glJournalEntryId: JOURNAL_ID,
    allocations: [{ invoiceId: INVOICE_ID, amountAllocated: 115 }],
    ...overrides,
  };
}

describe('voidSupplierPayment (P2.1 / audit W4)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([{ id: PAYMENT_ID, status: 'cancelled' }]);
    mockReverse.mockResolvedValue({ id: 'je-rev' });
    vi.mocked(lockPaymentBankLeg).mockResolvedValue({
      journalId: JOURNAL_ID, leg: { alreadyReversed: false, bankLineIds: [] },
    });
  });

  it('reverses the GL journal, un-applies allocations, and cancels the payment', async () => {
    mockGetPayment.mockResolvedValue(payment());
    const calls: Array<{ text: string; values: unknown[] }> = [];
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      calls.push({ text, values });
      if (/SELECT status, reversed_at/i.test(text)) {
        return Promise.resolve([{ status: 'posted', reversed_at: null }]);
      }
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(mockReverse).toHaveBeenCalledWith(COMPANY_ID, JOURNAL_ID, USER_ID);
    const allocUpdate = calls.find((c) => /UPDATE supplier_invoices/i.test(c.text));
    expect(allocUpdate, 'allocations must be un-applied').toBeTruthy();
    expect(allocUpdate!.text).toMatch(/amount_paid - /);
    const payUpdate = calls.find((c) => /UPDATE supplier_payments/i.test(c.text));
    expect(payUpdate!.text).toMatch(/'cancelled'/);
    expect(payUpdate!.text).toMatch(/status = 'processed'/); // guarded flip
  });

  // K-064 round 4: a draft/approved payment has moved nothing, so voiding it is
  // a status change only — the way out for one the process gate refuses. It
  // used to throw a bare Error, which the route answered 500.
  it('voids an unprocessed payment as a status change: no reversal, no bill touched', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'approved', glJournalEntryId: undefined }));
    const texts: string[] = [];
    mockSql.mockImplementation((strings: unknown) => {
      texts.push((strings as readonly string[]).join(' '));
      return Promise.resolve([{ id: PAYMENT_ID }]);
    });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(texts.some((t) => /UPDATE supplier_invoices/i.test(t))).toBe(false);
    expect(texts.some((t) => /UPDATE supplier_payments SET status = 'cancelled'/i.test(t))).toBe(true);
  });

  it('refuses voiding a cancelled payment with a typed refusal', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'cancelled', glJournalEntryId: undefined }));

    await expect(voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toMatchObject({
      code: 'SUPPLIER_PAYMENT_REFUSED',
    });
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('rejects voiding a reconciled payment', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'reconciled' }));

    await expect(voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toThrow(
      /reconcil/i,
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('runs inside a savepoint (4xx paths must not orphan-commit)', async () => {
    mockGetPayment.mockResolvedValue(payment({ status: 'draft' }));
    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID).catch(() => undefined);

    expect(withSavepoint).toHaveBeenCalledWith('void_supplier_payment', expect.any(Function));
  });

  it('takes the bank leg, then the payment, then the invoices, then the journal — the canonical order', async () => {
    // The inversion this pins: the void used to open with the journal
    // `FOR UPDATE` and reach `supplier_payments` last, which deadlocks against
    // `voidPaymentDocument` (payment -> invoices -> GL) on the same payment.
    mockGetPayment.mockResolvedValue(payment());
    const texts: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      texts.push(text);
      if (/SELECT status, reversed_at/i.test(text)) {
        return Promise.resolve([{ status: 'posted', reversed_at: null }]);
      }
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });
    vi.mocked(lockPaymentBankLeg).mockImplementation(async () => {
      texts.push('BANK-LEG');
      return { journalId: JOURNAL_ID, leg: { alreadyReversed: false, bankLineIds: [] } };
    });
    vi.mocked(lockJournalAndUnmatch).mockImplementation(async () => { texts.push('JOURNAL-LOCK'); });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    const at = (re: RegExp) => texts.findIndex((t) => re.test(t));
    const bank = at(/^BANK-LEG$/);
    const lock = at(/FROM supplier_payments[\s\S]*FOR UPDATE OF sp/i);
    const invoices = at(/UPDATE supplier_invoices/i);
    const journal = at(/^JOURNAL-LOCK$/);
    expect(bank, 'the bank leg must be locked first').toBe(0);
    expect(lock, 'the payment row must be locked').toBeGreaterThan(bank);
    expect(lock).toBeLessThan(invoices);
    expect(invoices).toBeLessThan(journal);
  });

  it('refuses a payment that does not exist for this tenant, before any write', async () => {
    mockSql.mockResolvedValue([]);
    // TYPED: the lock-first refusal is the same pre-write event the route
    // answers 404, so it must be the class the route keys on (K-107).
    await expect(voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID)).rejects.toBeInstanceOf(SupplierPaymentNotFoundError);
    expect(mockGetPayment).not.toHaveBeenCalled();
  });

  it('un-applies allocations in ascending invoice id, not capture order', async () => {
    const LOW = '11111111-0000-4000-8000-111111111111';
    const HIGH = '99999999-0000-4000-8000-999999999999';
    mockGetPayment.mockResolvedValue(payment({
      allocations: [{ invoiceId: HIGH, amountAllocated: 5 }, { invoiceId: LOW, amountAllocated: 5 }],
    }));
    const seen: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/UPDATE supplier_invoices/i.test(text)) seen.push(String(values[values.length - 2]));
      if (/SELECT status, reversed_at/i.test(text)) {
        return Promise.resolve([{ status: 'posted', reversed_at: null }]);
      }
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(seen).toEqual([LOW, HIGH]);
  });

  it('skips the GL reversal when the journal is already reversed', async () => {
    mockGetPayment.mockResolvedValue(payment());
    vi.mocked(lockPaymentBankLeg).mockResolvedValue({
      journalId: JOURNAL_ID, leg: { alreadyReversed: true, bankLineIds: [] },
    });
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SELECT status, reversed_at/i.test(text)) {
        return Promise.resolve([{ status: 'posted', reversed_at: '2026-07-01' }]);
      }
      return Promise.resolve([{ id: PAYMENT_ID, status: 'cancelled' }]);
    });

    await voidSupplierPayment(COMPANY_ID, PAYMENT_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
  });
});
