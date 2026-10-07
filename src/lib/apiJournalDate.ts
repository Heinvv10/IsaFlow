/**
 * sec-numrace S4: the ONE route answer for a journal dated outside the ledger window (gl/journalDateGuard).
 *
 * `withJournalDateRefusal` (brk-numrace G1/G2, round 6 fail-closed): a route that posts a journal runs that call in a
 * savepoint; a JournalDateRefusedError raised inside answers 400 only AFTER ROLLBACK TO SAVEPOINT, so whatever the call
 * locked or wrote is undone and the 4xx commits none of it. Nothing else answers it 400: withErrorHandler has no mapping
 * for it, so an unwrapped refusal — or one a caller caught, wrote after and rethrew — is the 500 that rolls back.
 */
import type { NextApiResponse } from 'next';
import { withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { apiResponse } from '@/lib/apiResponse';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';

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
    // k071): only the RELEASE failed (25P02), and withSavepoint has rolled back to the savepoint, so the request is
    // usable again. Without this savepoint the abort would have kept anything in the request from committing; keep it
    // so — the request is marked rollback-only (withAuth / bearerPipeline roll back whatever the route answers), and
    // the answer is handed back for the route to give.
    if (returned && (err as { code?: unknown }).code === '25P02') {
      const store = als.getStore();
      if (store) store.rollbackOnly = 'a posting call returned on a transaction it had aborted (apiJournalDate)';
      return value as T;
    }
    if (!isJournalDateRefused(err)) throw err;
    apiResponse.badRequest(res, err.message, { code: err.code });
    return JOURNAL_DATE_REFUSED;
  }
}
