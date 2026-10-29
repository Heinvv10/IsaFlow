/**
 * The 429 for a report the per-company limiter refused (`chargeReportRateLimit`),
 * naming the wait: `Retry-After` in whole seconds and the same wait in the
 * message ("try again in 5 minutes"), so a page can say when to retry instead
 * of leaving its reader to guess. With no known wait it says "shortly" and
 * sends no Retry-After. The Budget vs Actual route words its refusal the same way.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';

export function respondReportRateLimited(res: NextApiResponse, retryAfterSecs: number | null): void {
  if (retryAfterSecs === null) return apiResponse.tooManyRequests(res, 'Too many report requests: try again shortly.');
  res.setHeader('Retry-After', String(retryAfterSecs));
  const mins = Math.ceil(retryAfterSecs / 60);
  const wait = retryAfterSecs < 60
    ? `${retryAfterSecs} second${retryAfterSecs === 1 ? '' : 's'}`
    : `${mins} minute${mins === 1 ? '' : 's'}`;
  return apiResponse.tooManyRequests(res, `Too many report requests: try again in ${wait}.`);
}
