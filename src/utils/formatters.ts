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
