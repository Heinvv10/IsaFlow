/**
 * Shared formatting utilities for the Accounting app
 */

import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

/** Format a number as South African Rand (R 1 234.56) */
export function formatCurrency(amount: number): string {
  return formatMoney(amount);
}

/** A date for display (21 Oct 2026): from a Date, an ISO date or an ISO timestamp; '—' when there is none; text that is not a date comes back unchanged */
export function formatDate(dateStr: string | Date | null | undefined): string {
  return formatDisplayDate(dateStr);
}

/** Format an amount as Rand without its sign (R 1 234.56), for a figure whose direction is shown elsewhere */
export function formatRandAbs(amount: number): string {
  return formatMoney(Math.abs(amount));
}
