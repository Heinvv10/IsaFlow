/**
 * Shared guards for the migration wizard's invoice steps.
 *
 * Both live here rather than in either service because the AP and AR steps hit
 * the same two failure modes and must report them identically.
 */

import { log } from '@/lib/logger';
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
      'This file contains invoices with an amount already paid, which post against the Opening Balance Equity account. This company has no account with the opening_balance_equity role — add one to its chart of accounts and run the step again.',
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
