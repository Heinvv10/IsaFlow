/**
 * bankTxPageSizePref - the bank list's rows per page, remembered in this browser like the table density (WP4b review):
 * a plain visit to the page opens with the size last chosen instead of dropping back to 25. The URL's `size` wins when
 * it has one. Storage that is blocked or holds junk reads as no preference.
 */

import { log } from '@/lib/logger';
import { BANK_TX_PAGE_SIZES, type BankTxPageSize } from './bankTxUrlState';

export const PAGE_SIZE_KEY = 'isaflow.bankTxPageSize';

/** The remembered size, or undefined when there is none (or it is not one the list offers). */
export function readPageSizePref(): BankTxPageSize | undefined {
  try {
    const v = window.localStorage.getItem(PAGE_SIZE_KEY);
    return BANK_TX_PAGE_SIZES.find(n => String(n) === v);
  } catch (err) {
    log.warn('bank list: page size preference unreadable', { error: String(err) });
    return undefined;
  }
}

export function writePageSizePref(n: BankTxPageSize): void {
  try {
    window.localStorage.setItem(PAGE_SIZE_KEY, String(n));
  } catch (err) {
    log.warn('bank list: page size preference not saved', { error: String(err) });
  }
}
