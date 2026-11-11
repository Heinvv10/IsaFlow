/**
 * Tax directive type and status labels for /payroll/tax-directives (moved out of the page, unchanged: 300-line cap).
 */

export type DirectiveType = 'lump_sum' | 'retirement' | 'severance' | 'death';
export type DirectiveStatus = 'pending' | 'approved' | 'expired' | 'cancelled';

export const TYPE_LABELS: Record<DirectiveType, string> = {
  lump_sum: 'Lump Sum',
  retirement: 'Retirement',
  severance: 'Severance',
  death: 'Death',
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
