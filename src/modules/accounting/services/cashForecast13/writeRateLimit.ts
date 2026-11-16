/**
 * The write rate limit of the 13-week cash forecast's stored inputs (security LOW: an alternating-value loop
 * would grow audit_log without bound). One bucket per user, shared by the items, overrides and pay-day routes,
 * at the budget grid save's limit: 120 writes a minute (two a second, sustained), 429 with Retry-After past it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit } from '@/lib/rateLimit';

/**
 * Charges one write to the user's bucket; answers 429 and returns true when the bucket is full. The key and
 * limits are literals at the call, as the budget grid save writes them, so the R-175 rate-limit key census
 * (tests/unit/security/rateLimitKeyCensus.test.ts) can read them.
 */
export async function refuseIfWriteRateLimited(userId: string, res: NextApiResponse): Promise<boolean> {
  if (await checkRateLimit(`cash13-write:${userId}`, { max: 120, windowSecs: 60 })) return false;
  res.setHeader('Retry-After', '60');
  apiResponse.tooManyRequests(res, 'Too many cash forecast changes; wait a minute and try again.');
  return true;
}
