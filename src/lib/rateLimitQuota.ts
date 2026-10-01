/**
 * Giving usage-quota units back (R-175 review round 1).
 *
 * The limiter charges on its own connection, so a charge survives a request
 * that fails (K-103). That is right for an abuse limit: a failed login is still
 * an attempt. It is wrong for a usage quota, which bounds work actually done.
 * The daily AI bucket is 300 a day: with the provider down, 300 retries would
 * lock a company out for a day having received nothing.
 *
 * So `checkAiRateLimit` and `checkSendRateLimit` note what they charged the
 * daily bucket on the request context, and a request can give back only what
 * it noted:
 *  - `withAuth` gives all of it back when the request ends in a 5xx or a throw;
 *  - a handler gives it back itself where it knows the work was not done but
 *    still answers below 500 (a provider that is down, emails that failed).
 *
 * Only the daily bucket is given back. The 15-minute per-IP and per-company
 * buckets stay charged, so a loop of failing requests is still bounded. Only
 * `withAuth` keeps the list, so every caller here is authenticated.
 */

import { als, type RequestContext } from '@/lib/als';
import { log } from '@/lib/logger';
import { aiDailyKey, refundRateLimit, sendDailyKey } from '@/lib/rateLimit';

/**
 * A refund that fails must not turn the response it follows into an error, and
 * must not stop the next refund. It is logged; the units stay spent.
 */
async function giveBack(key: string, units: number): Promise<void> {
  try {
    await refundRateLimit(key, units);
  } catch (err) {
    log.error('Usage-quota refund failed', { key, units, error: err instanceof Error ? err.message : String(err) }, 'rateLimit');
  }
}

/** Gives back everything the request noted. Called by the owner of a failed request. */
export async function refundQuotaCharges(ctx: Pick<RequestContext, 'quotaCharges'> | null | undefined): Promise<void> {
  for (const { key, units } of ctx?.quotaCharges?.splice(0) ?? []) await giveBack(key, units);
}

/**
 * Gives back up to `units` of what THIS request charged `key`, and no more: a
 * request that charged nothing, or has already given its units back, refunds
 * nothing. That is what stops a handler bug from draining another caller's count.
 */
async function refundOwnCharge(key: string, units: number): Promise<void> {
  const charges = als.getStore()?.quotaCharges;
  const charge = charges?.find((c) => c.key === key);
  if (!charges || !charge) return;
  const back = Math.min(charge.units, Math.trunc(units));
  if (!(back >= 1)) return;
  charge.units -= back;
  if (charge.units === 0) charges.splice(charges.indexOf(charge), 1);
  await giveBack(key, back);
}

/** The AI call this request was charged for did not happen. */
export function refundAiDailyQuota(companyId: string, name: string): Promise<void> {
  return refundOwnCharge(aiDailyKey(name, companyId), 1);
}

/** `count` of the emails this request was charged for were not sent. */
export function refundSendDailyQuota(companyId: string, name: string, count: number): Promise<void> {
  return refundOwnCharge(sendDailyKey(name, companyId), count);
}
