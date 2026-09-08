/**
 * Two properties of approveCustomerInvoice that a bulk approve depends on.
 *
 * Adversarial review, 2026-09-08.
 *
 * 1. THE PDF SEAL MUST NOT BE ABLE TO ABORT THE TRANSACTION. The seal is
 *    documented as non-blocking — "if storage is flaky the status transition
 *    still succeeds" — and that was false inside a shared transaction.
 *    `snapshotInvoicePdf` does real SQL (INSERT captured_documents, then two
 *    UPDATEs), so a Postgres-level failure leaves the CONNECTION aborted. The
 *    catch then returns normally and the next statement on that connection —
 *    in a bulk approve, the enclosing withSavepoint's own RELEASE SAVEPOINT —
 *    raises 25P02, turning a perfectly postable invoice into a failure that
 *    takes 99 good approvals with it. Wrapping the seal in its own savepoint is
 *    what makes the catch mean what it says.
 *
 * 2. THE COMPARE-AND-SWAP MUST BE BOUNDED. A CAS is stronger than a lock
 *    against double-posting and weaker against hanging: the loser does not get
 *    "matched zero rows", it BLOCKS on the winner's row lock for the winner's
 *    whole transaction — up to 100 renders and uploads. Nothing sets
 *    lock_timeout globally, so without one the wait is unbounded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/als', () => ({
  als: { getStore: vi.fn() },
  assertTxUsable: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  postCustomerInvoiceToGL: vi.fn(async () => 'je-1'),
}));
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';
import {
  approveCustomerInvoice,
  CustomerInvoiceLockTimeoutError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';

const COMPANY = 'company-1';
const USER = 'user-1';
const INVOICE = '0a000000-0000-4000-8000-000000000001';

let clientQuery: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clientQuery = vi.fn(async () => ({ rows: [] }));
  vi.mocked(als.getStore).mockReturnValue({ client: { query: clientQuery } } as never);
  // The guarded UPDATE claims the transition.
  vi.mocked(sql).mockResolvedValue([{ id: INVOICE }] as never);
  vi.mocked(withSavepoint).mockImplementation(
    (async (_n: string, fn: () => Promise<unknown>) => fn()) as never,
  );
  vi.mocked(snapshotInvoicePdf).mockResolvedValue({
    documentId: 'doc-1', wasExisting: false,
  } as never);
});

describe('approveCustomerInvoice — the PDF seal is contained', () => {
  it('runs the snapshot inside its own savepoint', async () => {
    await approveCustomerInvoice(COMPANY, INVOICE, USER);
    const names = vi.mocked(withSavepoint).mock.calls.map((c) => c[0] as string);
    expect(names).toContain('invoice_pdf_snapshot');
  });

  /**
   * The approval must stand. This is the behaviour the comment always claimed;
   * the savepoint is what finally makes it true against a SQL-level failure.
   */
  it('still approves when the seal fails, and reports no evidence document', async () => {
    vi.mocked(snapshotInvoicePdf).mockRejectedValue(
      Object.assign(new Error('insert or update on table "captured_documents" failed'),
        { code: '23503' }),
    );
    const result = await approveCustomerInvoice(COMPANY, INVOICE, USER);
    expect(result.status).toBe('approved');
    expect(result.glJournalEntryId).toBe('je-1');
    expect(result.evidenceDocumentId).toBeNull();
  });

  /** The savepoint is what absorbs it — not the catch alone. */
  it('rolls the failed seal back through the savepoint rather than the bare catch', async () => {
    const failed: string[] = [];
    vi.mocked(withSavepoint).mockImplementation((async (name: string, fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch (err) {
        failed.push(name);
        throw err;
      }
    }) as never);
    vi.mocked(snapshotInvoicePdf).mockRejectedValue(new Error('storage down'));
    await approveCustomerInvoice(COMPANY, INVOICE, USER);
    expect(failed).toEqual(['invoice_pdf_snapshot']);
  });
});

describe('approveCustomerInvoice — the compare-and-swap is bounded', () => {
  it('sets a 5s lock_timeout before claiming the transition', async () => {
    await approveCustomerInvoice(COMPANY, INVOICE, USER);
    expect(clientQuery).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5s'");
  });

  /**
   * SET LOCAL lasts to the end of the TRANSACTION. Left set, the 5s budget
   * would govern every later lock in the same request — in a bulk approve, the
   * other 99 invoices and the locks the journal posting itself takes.
   */
  it('restores the default on the success path', async () => {
    await approveCustomerInvoice(COMPANY, INVOICE, USER);
    expect(clientQuery).toHaveBeenCalledWith('SET LOCAL lock_timeout = DEFAULT');
  });

  it('raises the typed timeout so the bulk runner can skip the element', async () => {
    vi.mocked(sql).mockRejectedValue(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    );
    const err = await approveCustomerInvoice(COMPANY, INVOICE, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomerInvoiceLockTimeoutError);
    expect((err as CustomerInvoiceLockTimeoutError).code).toBe('CUSTOMER_INVOICE_LOCK_TIMEOUT');
  });

  /**
   * Deliberately NOT in a finally: after a lock timeout the transaction is
   * aborted, so restoring the default would itself raise 25P02 and replace the
   * typed error with an opaque one.
   */
  it('does not try to restore the default after a timeout', async () => {
    vi.mocked(sql).mockRejectedValue(
      Object.assign(new Error('lock timeout'), { code: '55P03' }),
    );
    await approveCustomerInvoice(COMPANY, INVOICE, USER).catch(() => undefined);
    expect(clientQuery).not.toHaveBeenCalledWith('SET LOCAL lock_timeout = DEFAULT');
  });

  /** Outside a request transaction there is no client to configure; it must not crash. */
  it('works when no request transaction is in flight', async () => {
    vi.mocked(als.getStore).mockReturnValue(undefined as never);
    const result = await approveCustomerInvoice(COMPANY, INVOICE, USER);
    expect(result.status).toBe('approved');
  });
});
