/**
 * The sub-account a bookkeeper last opened in each bank group, kept per
 * browser so the group card can offer "Resume: <name>". A convenience only:
 * storage can be missing or refuse (private window, blocked site data), and
 * then the card simply offers nothing.
 */

import { log } from '@/lib/logger';

const key = (groupId: string) => `isaflow_bank_group_last:${groupId}`;

export function readLastOpened(groupId: string): string | null {
  try {
    return window.localStorage.getItem(key(groupId));
  } catch (err) {
    log.warn('Last-opened sub-account unavailable', { error: err }, 'bank-transactions');
    return null;
  }
}

export function writeLastOpened(groupId: string, accountId: string): void {
  try {
    window.localStorage.setItem(key(groupId), accountId);
  } catch (err) {
    log.warn('Could not remember the last-opened sub-account', { error: err }, 'bank-transactions');
  }
}
