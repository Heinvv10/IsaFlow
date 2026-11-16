/**
 * The write rate limit of the 13-week cash forecast's stored inputs (security LOW: an alternating-value loop
 * would grow audit_log without bound). One bucket per user, shared by the items, overrides and pay-day routes,
 * at the budget grid save's limit: 120 writes a minute (two a second, sustained), 429 with Retry-After past it.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit } from '@/lib/rateLimit';

export const CASH13_WRITE_LIMIT = { max: 120, windowSecs: 60 } as const;

/** Charges one write to the user's bucket; answers 429 and returns true when the bucket is full. */
export async function refuseIfWriteRateLimited(userId: string, res: NextApiResponse): Promise<boolean> {
  if (await checkRateLimit(`cash13-write:${userId}`, CASH13_WRITE_LIMIT)) return false;
  res.setHeader('Retry-After', String(CASH13_WRITE_LIMIT.windowSecs));
  apiResponse.tooManyRequests(res, 'Too many cash forecast changes; wait a minute and try again.');
  return true;
}
