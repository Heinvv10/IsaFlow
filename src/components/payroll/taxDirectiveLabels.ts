/**
 * Tax directive type and status labels for /payroll/tax-directives (moved out of the page, unchanged: 300-line cap).
 */

import type { DirectiveKind } from '@/modules/accounting/services/payroll/taxDirectiveKinds';
import { formatMoney } from '@/lib/money/formatMoney';

export type DirectiveType = DirectiveKind;
export type DirectiveStatus = 'pending' | 'approved' | 'expired' | 'cancelled';

export const TYPE_LABELS: Record<DirectiveType, string> = {
  lump_sum: 'Lump Sum',
  retirement: 'Retirement',
  severance: 'Severance',
  death: 'Death',
  // Regular pay (wave 5 DR): the SARS form letters, G21 Rev 1 p. 16.
  fixed_percentage: 'Fixed percentage (IRP3(b))',
  fixed_amount: 'Fixed amount (IRP3(c))',
};

export const STATUS_LABELS: Record<DirectiveStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const STATUS_COLOURS: Record<DirectiveStatus, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  approved: 'bg-teal-500/20 text-teal-400',
  expired: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
  cancelled: 'bg-red-500/20 text-red-400',
};

/** The list's Amount cell: a lump sum's gross, a fixed-amount directive's PAYE a month, nothing for a percentage (no gross is stored). */
export function directiveAmountCell(d: { directiveType: DirectiveType; amount: number; taxAmount: number | null }): string {
  if (d.directiveType === 'fixed_amount') return `${formatMoney(d.taxAmount ?? 0)} PAYE a month`;
  return d.directiveType === 'fixed_percentage' ? '—' : formatMoney(d.amount);
}
