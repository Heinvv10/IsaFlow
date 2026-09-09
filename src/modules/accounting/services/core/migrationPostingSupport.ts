/**
 * Shared posting rules for the migration wizard's take-on documents.
 *
 * A document imported by the wizard is a TAKE-ON, not an origination. It was
 * raised, and often partly settled, before the cutover, in the system being
 * migrated from. Only what is still outstanding belongs in this ledger.
 *
 * So the entry is two lines at `total - amountPaid`, against
 * `opening_balance_equity`, and it carries no revenue, expense or VAT line at
 * all. Posting the full invoice and settling the paid part back out would:
 *
 *   - RE-DECLARE THE VAT. getVATReturn is GL-based and sweeps every posted line
 *     on a vat_input/vat_output account into the return; lines with a NULL
 *     vat_type land in boxes 1 and 15. Neither import passes a vat_type, so
 *     every take-on document would declare its VAT a second time, in a period
 *     that is usually already filed. `no_vat` does not help — it maps to box 18.
 *   - RESTATE PRE-CUTOVER P&L into a closed period, visible in every income
 *     statement, AFS and pack that spans it.
 *   - Require a permanent `source <> 'auto_migration'` filter in every future
 *     VAT and P&L reader.
 *
 * Lines that are never written need no filter. This is what Xero's conversion
 * balances and Sage's take-on do.
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getSystemAccountId } from '../gl/systemAccountResolver';

export interface TakeOnLine {
  glAccountId: string;
  debit: number;
  credit: number;
  description: string;
}

/**
 * The two lines of a take-on entry.
 *
 * `receivable`: DR the control account, CR the clearing account — the customer
 * owes us what is outstanding. `payable` mirrors it.
 *
 * Returns an empty array when nothing is outstanding: a document settled in full
 * before the cutover has no balance to take on, so it is created as a document
 * and posts nothing.
 */
export function buildTakeOnLines(
  controlAccountId: string,
  clearingAccountId: string,
  outstanding: number,
  side: 'receivable' | 'payable',
  documentNumber: string,
): TakeOnLine[] {
  if (outstanding <= 0) return [];
  const control = {
    glAccountId: controlAccountId,
    debit: side === 'receivable' ? outstanding : 0,
    credit: side === 'receivable' ? 0 : outstanding,
    description: `Take-on ${side === 'receivable' ? 'AR' : 'AP'} — ${documentNumber}`,
  };
  const clearing = {
    glAccountId: clearingAccountId,
    debit: side === 'receivable' ? 0 : outstanding,
    credit: side === 'receivable' ? outstanding : 0,
    description: `Opening balance equity — ${documentNumber}`,
  };
  return side === 'receivable' ? [control, clearing] : [clearing, control];
}

/**
 * Serialise the wizard's document steps for one company.
 *
 * The steps are idempotent by lookup, not by constraint: `duplicate_fingerprint`
 * cannot carry a unique index (production holds groups of 55-79 live invoices
 * sharing one value), and `customer_invoices` is unique on the invoice number
 * only. A read-then-write is safe against a re-run and NOT against two runs at
 * the same instant — two imports of one file would each find nothing and both
 * insert.
 *
 * A transaction-scoped advisory lock closes that: the second request blocks
 * here until the first commits, and then its lookup sees the rows the first
 * wrote. `withAuth` gives the request exactly one transaction, so the lock is
 * released on COMMIT or ROLLBACK with no unlock to forget. Re-entrant, so a
 * step that takes it twice is fine.
 *
 * Keyed on the company: two different tenants never wait on each other.
 */
export async function lockMigrationImport(companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${companyId + ':migration-import'}))`;
}

/**
 * The clearing account every take-on entry posts against, resolved ONCE for the
 * whole step.
 *
 * Unconditional now: under the take-on shape EVERY document with an outstanding
 * balance needs it, not only the part-paid ones. Resolving it per row turned one
 * missing account into a failure repeated for every row, each rolling back after
 * its INSERT had already succeeded. A company either has the account or it does
 * not, so ask once and fail the step with a single message naming the remedy.
 */
export async function resolveTakeOnClearingAccountId(companyId: string): Promise<string> {
  try {
    return await getSystemAccountId('opening_balance_equity', companyId);
  } catch (err) {
    // The cause is nearly always a missing account, but it can also be an
    // aborted transaction or a dropped connection, and telling the operator to
    // fix their chart of accounts would send them the wrong way. Keep the real
    // cause in the log while the message names the likely remedy.
    log.warn(
      'Could not resolve the opening_balance_equity account for a migration import',
      { companyId, error: err instanceof Error ? err.message : String(err) },
      'migration',
    );
    throw new Error(
      'Imported documents are taken on against the Opening Balance Equity account. This company has no account with the opening_balance_equity role — add one to its chart of accounts and run the step again.',
    );
  }
}

/**
 * 42P10 — "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification". Both invoice imports name an arbiter index by its columns, so
 * this code means the index the step depends on is absent from this database.
 *
 * The per-row savepoint would otherwise contain it and the step would answer
 * 200 with `imported: 0` and a raw Postgres message on every row. Rethrow so
 * the run aborts on the first row and says which index is missing.
 */
export function rethrowIfConflictTargetMissing(err: unknown, missingIndex: string): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '42P10') {
    throw new Error(
      `Invoice import is unavailable: this database has no ${missingIndex} index, which the import depends on. No invoices were imported.`,
    );
  }
}
