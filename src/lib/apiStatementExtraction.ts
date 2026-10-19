/**
 * HTTP side of a refused statement action (retry, delete, commit, rollback, rematch, reconcile).
 *
 * The refusals are all decided before the first write, so a 4xx loses nothing even though
 * withAuth commits a 4xx. Anything else is not answered here: the caller rethrows it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { ExtractionActionRefusedError } from '@/modules/accounting/services/bank/statementExtractionState';

/** Answer `err` and return true when it is a refused statement action; return false for any other error. */
export function respondToStatementRefusal(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof ExtractionActionRefusedError)) return false;
  if (err.code === 'NOT_FOUND') apiResponse.notFound(res, 'Statement');
  else apiResponse.conflict(res, err.message);
  return true;
}
