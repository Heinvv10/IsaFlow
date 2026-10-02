/**
 * Route categories that get per-company rate limiting from the auth wrappers
 * without each handler having to opt in. Pentest M23.
 *
 * ONE table, used by both `withAuth` (cookie) and the bearer pipeline. They
 * used to hold a hand-copied table each. Both write the same counter row
 * (`reports:<company>`), and one row has one window: had the copies ever
 * disagreed, each path would have kept resetting the other's count (R-175, the
 * same defect as the shared `portal-auth:` key).
 *
 * The table is intentionally small — add a pattern here, not a one-off in each
 * handler.
 */

import { checkRateLimit } from '@/lib/rateLimit';

export const AUTO_RATE_LIMIT: ReadonlyArray<{ prefix: string; key: string; max: number; windowSecs: number }> = [
  { prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60 },
];

/** False when the request's path has a bucket and the company is over it. */
export async function checkAutoRateLimit(url: string | undefined, companyId: string): Promise<boolean> {
  const path = url?.split('?')[0] ?? '';
  const bucket = AUTO_RATE_LIMIT.find((b) => path.startsWith(b.prefix));
  if (!bucket) return true;
  return checkRateLimit(`${bucket.key}:${companyId}`, { max: bucket.max, windowSecs: bucket.windowSecs });
}
