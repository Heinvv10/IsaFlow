/**
 * NUMRACE: the ONE route answer for a run that would post journals in more than MAX_RUN_YEARS years —
 * `YearSpanTooWideError` (core/yearSpanRefusal), 400 with its own "split it" wording. Safe as a 4xx because it is
 * raised before any lock or write (`withAuth` COMMITs below 500). `respondToUnhandledError` asks it, so every route
 * that rethrows answers the same 400.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { isYearSpanTooWide } from '@/modules/accounting/services/core/yearSpanRefusal';

export function respondIfYearSpanTooWide(res: NextApiResponse, err: unknown): boolean {
  if (!isYearSpanTooWide(err)) return false;
  apiResponse.badRequest(res, err.message);
  return true;
}
