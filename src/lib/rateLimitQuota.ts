/**
 * Giving unused usage-quota units back (R-175).
 *
 * The limiter charges on its own connection, so a charge survives a request
 * that fails (K-103). That is right for an abuse limit: a failed login is still
 * an attempt. It is wrong for a usage quota, which bounds work actually done.
 * The daily AI bucket is 300 a day: with the provider refusing connections or
 * answering with errors, 300 retries would lock a company out for a day having
 * received nothing. (An outage that shows as HANGS still does that: a timeout
 * counts as use, because the provider may have done and billed the work.)
 *
 * The rule is one line: when the request ends, however it ends, each noted
 * charge gets back `charged - used`, never less than zero.
 *
 *  - `checkAiRateLimit` / `checkSendRateLimit` note the DAILY charge when the
 *    caller passes `refundUnused: true` (`@/lib/quotaUse`).
 *  - The shared AI and email clients record use where the work happens.
 *  - `withAuth` settles the list at the end of every request, whatever its
 *    status: a 200 that fell back because the provider was down gets its unit
 *    back; a 500 thrown after 59 of 100 emails went out gets 41 back.
 *
 * Fail safe: a caller that does not ask for `refundUnused` notes nothing and
 * keeps its charge. Only ask for it when the route's work goes through a
 * client that calls `markQuotaUsed`.
 *
 * Only the daily bucket is ever given back. The 15-minute per-IP and
 * per-company buckets stay charged, and they are what bounds a loop of
 * requests that do no work. Only `withAuth` keeps the list, so every caller is
 * authenticated.
 */

import type { RequestContext } from '@/lib/als';
import { log } from '@/lib/logger';
import { refundRateLimit } from '@/lib/rateLimit';

/**
 * Gives back what the request charged and did not use, once. A refund that
 * fails must not change the response it follows, nor stop the next refund: it
 * is logged and the units stay spent.
 */
export async function settleQuotaCharges(ctx: Pick<RequestContext, 'quotaCharges'> | null | undefined): Promise<void> {
  for (const { key, charged, used, windowStart } of ctx?.quotaCharges?.splice(0) ?? []) {
    // Capped at the charge: whatever `used` holds, never more than was taken.
    const unused = Math.min(Math.trunc(charged), Math.trunc(charged - used));
    if (!(unused >= 1)) continue;
    try {
      // Only into the window that was charged: after a rollover it is a no-op.
      await refundRateLimit(key, unused, windowStart);
    } catch (err) {
      log.error('Usage-quota refund failed', { key, units: unused, error: err instanceof Error ? err.message : String(err) }, 'rateLimit');
    }
  }
}
