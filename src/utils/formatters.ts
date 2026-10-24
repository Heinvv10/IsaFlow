/**
 * Shared formatting utilities for the Accounting app
 */

import { formatSaDateValue } from '@/lib/saDateParser';
import { formatMoney } from '@/lib/money/formatMoney';

/** Format a number as South African Rand (R 1 234.56) */
export function formatCurrency(amount: number): string {
  return formatMoney(amount);
}

/** Format a date for display (21 Oct 2026); '—' when there is none or it is not a date */
export function formatDate(dateStr: string | Date | null | undefined): string {
  const shown = formatSaDateValue(dateStr);
  return /^\d{2} [A-Z][a-z]{2} \d{4}$/.test(shown) ? shown : '—';
}

/** Format an amount as Rand without its sign (R 1 234.56), for a figure whose direction is shown elsewhere */
export function formatRandAbs(amount: number): string {
  return formatMoney(Math.abs(amount));
}
