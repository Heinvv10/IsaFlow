/**
 * rowLabel(tx): "{date} {description} {amount}", the row-scoped half of every bank grid control's
 * accessible name ("VAT, 01 Jun 2026 WOOLWORTHS −R 1 234.50"). A page holds ~25 rows of identical
 * selects; without it a screen reader hears "VAT" 25 times and cannot tell which row it is on.
 */

import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { BankTx } from './bankTxTypes';

export function rowLabel(tx: BankTx): string {
  const description = (tx.description || '').trim().replace(/\s+/g, ' ') || 'No description';
  return `${formatDisplayDate(tx.transactionDate)} ${description} ${formatMoney(tx.amount)}`;
}
