/**
 * Usage-quota bookkeeping on the request context (R-175).
 *
 * A usage quota bounds work actually done: AI calls a provider answered,
 * emails a mail server accepted. The limiter charges the quota up front; the
 * place that does the work records that it was done; the request's owner gives
 * back what was charged and not used (`@/lib/rateLimitQuota`).
 *
 * This file is deliberately tiny and depends only on `@/lib/als`, so the
 * shared AI and email clients can import it without pulling in the limiter.
 *
 * Only `withAuth` keeps the list. Anywhere else both functions do nothing and
 * a charge simply stands.
 */

import { als } from '@/lib/als';

export type QuotaKind = 'ai' | 'send';

/** Called by the limiter: this request charged `units` of `key`, refundable if unused. */
export function noteQuotaCharge(kind: QuotaKind, key: string, units: number): void {
  als.getStore()?.quotaCharges?.push({ kind, key, charged: units, used: 0 });
}

/**
 * Called where the bounded work happens, once it has happened: a provider
 * answered, a mail server accepted a message. Call it at the shared client,
 * not in each route. A route whose work never reaches a call to this must not
 * ask for `refundUnused`, or its quota would always be given back.
 */
export function markQuotaUsed(kind: QuotaKind, units = 1): void {
  // Use can only be added. A zero, negative or NaN count would otherwise turn
  // into a refund the request did not earn.
  if (!(units >= 1)) return;
  for (const charge of als.getStore()?.quotaCharges ?? []) {
    if (charge.kind === kind) charge.used += units;
  }
}
