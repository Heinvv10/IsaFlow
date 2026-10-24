/**
 * Shared formatting utilities for the Accounting app
 */

/** Format a number as South African Rand (R 1,234.56) */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

/** Format a date string to locale display format (DD/MM/YYYY) */
export function formatDate(dateStr: string | Date | null | undefined): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA');
}

/** Format an amount as Rand without its sign (R 1,234.56), for a figure whose direction is shown elsewhere */
export function formatRandAbs(amount: number): string {
  return 'R ' + Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
