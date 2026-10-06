/**
 * sec-numrace S4: the route answer for a journal dated outside the ledger window (gl/journalDateGuard) — 400 when the
 * request had written nothing before it; otherwise left to the 500 that rolls those writes back (withAuth COMMITs below
 * 500, and a document saved without its journal is worse than a failed request). `respondToUnhandledError` asks it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';

export function respondIfJournalDateRefused(res: NextApiResponse, err: unknown): boolean {
  if (!isJournalDateRefused(err) || !err.preWrite) return false;
  apiResponse.badRequest(res, err.message, { code: err.code });
  return true;
}
