/**
 * Shared guards for the migration wizard's invoice steps.
 *
 * Both live here rather than in either service because the AP and AR steps hit
 * the same two failure modes and must report them identically.
 */

import { getSystemAccountId } from '../gl/systemAccountResolver';

/**
 * The clearing account the settlement leg posts against, resolved ONCE for the
 * whole step.
 *
 * Resolving it per row turned one missing account into a failure repeated for
 * every part-paid invoice in the file, each rolling back after its INSERT had
 * already succeeded. A company either has the account or it does not, so ask
 * once and fail the step with a single message naming the remedy.
 *
 * Returns null when no row in the file is part-paid: an import of nothing but
 * unpaid invoices needs no clearing account, and must not be blocked by one.
 */
export async function resolveSettlementAccountId(
  companyId: string,
  anyRowIsPartPaid: boolean,
): Promise<string | null> {
  if (!anyRowIsPartPaid) return null;
  try {
    return await getSystemAccountId('opening_balance_equity', companyId);
  } catch {
    throw new Error(
      'This file contains invoices with an amount already paid, which post against the Opening Balance Equity account. This company has no account with the opening_balance_equity role — add one to its chart of accounts and run the step again.',
    );
  }
}

/**
 * 42P10 — "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification". The AP INSERT names the arbiter that migration 625 creates,
 * so this code means 625 has not been applied to this database.
 *
 * The per-row savepoint would otherwise contain it and the step would answer
 * 200 with `imported: 0` and a raw Postgres message on every row. Rethrow so
 * the run aborts on the first row and says what to do.
 */
export function rethrowIfDuplicateIndexMissing(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '42P10') {
    throw new Error(
      'Supplier invoice import is unavailable: database migration 625 (uq_supplier_invoices_supplier_fingerprint) has not been applied. No invoices were imported.',
    );
  }
}
