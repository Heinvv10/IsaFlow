/**
 * Row-lock helper for the supplier-invoice APPROVE path.
 *
 * `approveSupplierInvoice` reads the invoice with a plain SELECT
 * (`getSupplierInvoiceById`), refuses on the wrong status, posts the
 * Expense/VAT/AP journal, and only THEN writes `status = 'approved'`. Two
 * concurrent calls both read 'draft' and both post — one bill, two journals,
 * the payable credited twice — and the second `UPDATE` overwrites the first's
 * `gl_journal_entry_id`, orphaning that journal where no reversal can find it.
 *
 * The same file's `cancelSupplierInvoiceInner` has taken `FOR UPDATE` for this
 * exact reason since the C1 audit. Approve was simply never given the same
 * treatment; this closes that asymmetry rather than introducing a new pattern.
 *
 * WHY IT MATTERS MORE NOW. `bulk_approve_supplier_invoices` holds one request
 * transaction open across up to 100 invoices while taking no lock on any of
 * them. A concurrent single approve — the UI's bulk-action bar, a second agent,
 * an operator clicking Approve — reaching invoice #87 while the batch is still
 * on #12 is a window measured in seconds, not the milliseconds the single-call
 * race needed. The bulk tool does not create this defect, but it is what turns
 * it from theoretical into reachable on a normal month-end.
 *
 * A fresh idempotency key defeats the registry's replay guard, so an agent
 * retrying an apparently-hung call is exactly the caller that triggers this.
 *
 * Mirrors creditNoteLock.ts and bankTxLock.ts deliberately — same defect class,
 * same remedy. Since PR #264 every request runs inside a single transaction on
 * the AsyncLocalStorage-bound client, so `FOR UPDATE` taken here is held for the
 * rest of the request: the second request blocks on the row until the first
 * commits, then re-reads the settled status and refuses.
 *
 * Write paths ONLY — never call this from a list/query service.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the row longer than the 5s `lock_timeout`.
 *
 * Carries a stable `code` rather than relying on `instanceof`: the bulk tool's
 * posting loop treats a lock timeout as a SKIP (it is write-free — the lock is
 * taken before anything is posted) and must not import an AP service just to
 * compare constructors. The supplier-invoice routes surface a caught service
 * error's message to the caller, so the wording has to say "retry".
 */
export class SupplierInvoiceLockTimeoutError extends Error {
  readonly code = 'SUPPLIER_INVOICE_LOCK_TIMEOUT';
  constructor(invoiceId: string) {
    super(`Supplier invoice ${invoiceId} is being processed by another request — retry in a moment.`);
    this.name = 'SupplierInvoiceLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Read one supplier invoice for a company and hold a row lock on it until the
 * end of the surrounding transaction. Returns `null` when the row does not
 * exist or belongs to another tenant — callers keep their own not-found
 * wording, so no cross-tenant probe can tell the two apart.
 *
 * Throws if no request transaction is in flight: outside one, every statement is
 * its own implicit transaction, so `FOR UPDATE` releases the instant the SELECT
 * returns and the caller believes it is serialised when it is not. A loud
 * failure beats a lock that silently does nothing.
 *
 * The 5s `lock_timeout` is re-issued on EVERY call rather than memoised — see
 * bankTxLock.ts for why (`SET LOCAL` is subtransaction-aware, and a savepoint
 * rollback restores it to `0`, meaning no timeout at all). That matters
 * particularly here: every element of a bulk approve runs in its own savepoint.
 */
export async function lockSupplierInvoiceForUpdate(
  companyId: string,
  invoiceId: string,
): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockSupplierInvoiceForUpdate requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }

  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT * FROM supplier_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE`) as DbRow[];
    // Restore the default ON THE SUCCESS PATH ONLY. `SET LOCAL` lasts to the end
    // of the TRANSACTION, not the statement, so without this the 5s budget
    // silently governs every lock taken afterwards in the same request — and in
    // a bulk approve that is the other 99 invoices plus every lock the journal
    // posting itself takes. Those would fail with a bare 55P03 that nothing maps
    // to SupplierInvoiceLockTimeoutError, reaching the agent as GENERIC_FAILURE
    // and failing the whole batch for what should have been one skipped line.
    //
    // Deliberately NOT in a `finally`: after a lock timeout the transaction is
    // aborted, so this statement would itself throw 25P02 and REPLACE the typed
    // error with an opaque one (creditNoteLock.test.ts pins that mistake).
    // On the failure path the setting is irrelevant — the transaction is being
    // rolled back, and in the bulk case the savepoint is what unwinds it.
    //
    // The row lock is unaffected either way: it is already held, and locks are
    // released by COMMIT, not by this setting.
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new SupplierInvoiceLockTimeoutError(invoiceId);
    throw err;
  }
}
