/**
 * The transfer link batches a user dismissed from the Bank Transactions notice, kept per browser and bank account.
 * A convenience only: storage can be missing or refuse (private window, blocked site data), and then the notice
 * simply shows again. Dismissing hides the notice; the log stays reachable.
 */

import { log } from '@/lib/logger';

const MAX_KEPT = 50;
const key = (bankAccountId: string) => `isaflow.bankTx.transferLinkNotice.dismissed.${bankAccountId}`;

export function readDismissed(bankAccountId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key(bankAccountId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch (err) {
    log.warn('Dismissed transfer link notices unavailable', { error: err }, 'bank-transactions');
    return [];
  }
}

/** Store the ids (newest last, at most 50) and return what was kept. */
export function writeDismissed(bankAccountId: string, ids: string[]): string[] {
  const kept = [...new Set(ids)].slice(-MAX_KEPT);
  try {
    window.localStorage.setItem(key(bankAccountId), JSON.stringify(kept));
  } catch (err) {
    log.warn('Could not remember a dismissed transfer link notice', { error: err }, 'bank-transactions');
  }
  return kept;
}
