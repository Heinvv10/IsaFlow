/**
 * sec-numrace S4: the route answer for a journal dated outside the ledger window (gl/journalDateGuard).
 *
 * `respondIfJournalDateRefused` (asked by `respondToUnhandledError`): 400 when the request had written nothing before
 * it; otherwise left to the 500 that rolls those writes back (withAuth COMMITs below 500, and a document saved
 * without its journal is worse than a failed request).
 *
 * `withJournalDateRefusal` (brk-numrace G1/G2): a route that posts a journal from a STORED document date (approve,
 * post, confirm) runs that call in a savepoint; a refusal raised inside answers 400 only AFTER the savepoint has rolled
 * back, so whatever the call locked or wrote is undone and the 4xx commits none of it.
 */
import type { NextApiResponse } from 'next';
import { withSavepoint } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';

export function respondIfJournalDateRefused(res: NextApiResponse, err: unknown): boolean {
  if (!isJournalDateRefused(err) || !err.preWrite) return false;
  apiResponse.badRequest(res, err.message, { code: err.code });
  return true;
}

/** What `withJournalDateRefusal` returns once it has answered: the route returns without writing anything further. */
export const JOURNAL_DATE_REFUSED = Symbol('journal-date-refused');

export async function withJournalDateRefusal<T>(
  res: NextApiResponse, fn: () => Promise<T>,
): Promise<T | typeof JOURNAL_DATE_REFUSED> {
  let returned = false;
  let value: T | undefined;
  try {
    return await withSavepoint('journal_date_refusal', async () => {
      value = await fn();
      returned = true;
      return value;
    });
  } catch (err) {
    // The call RETURNED an answer on a transaction it had itself aborted (a held-row outcome its route answers 503,
    // k071): only the RELEASE failed (25P02), and withSavepoint has rolled back to the savepoint. Hand the answer back,
    // exactly as without this savepoint.
    if (returned && (err as { code?: unknown }).code === '25P02') return value as T;
    if (!isJournalDateRefused(err)) throw err;
    apiResponse.badRequest(res, err.message, { code: err.code });
    return JOURNAL_DATE_REFUSED;
  }
}
