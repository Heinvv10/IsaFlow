/**
 * rowLabel(tx): "{date} {description} {amount}", the row-scoped half of every bank grid control's
 * accessible name ("VAT, 01 Jun 2026 WOOLWORTHS −R 1 234.50"). A page holds ~25 rows of identical
 * selects; without it a screen reader hears "VAT" 25 times and cannot tell which row it is on.
 * The description is capped at 60 characters: bank narratives run long, and the name is heard per control.
 * rowLabels(txs) is what the grid uses: rows whose labels collide (two R5 fees on one day) get their
 * position on the page, so every name on the page is unique.
 */

import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { BankTx } from './bankTxTypes';

const MAX_DESCRIPTION = 60;

export function rowLabel(tx: BankTx): string {
  const full = (tx.description || '').trim().replace(/\s+/g, ' ') || 'No description';
  const description = full.length > MAX_DESCRIPTION ? `${full.slice(0, MAX_DESCRIPTION - 1)}…` : full;
  return `${formatDisplayDate(tx.transactionDate)} ${description} ${formatMoney(tx.amount)}`;
}

export function rowLabels(txs: BankTx[]): Map<string, string> {
  const base = txs.map(rowLabel);
  const count = new Map<string, number>();
  for (const l of base) count.set(l, (count.get(l) ?? 0) + 1);
  return new Map(txs.map((tx, i) => [tx.id, count.get(base[i]!)! > 1 ? `${base[i]} (row ${i + 1})` : base[i]!]));
}
