/** Display formatting shared by the aging drill-down panels. */
import { formatDisplayDate } from '@/utils/dateFormat';

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatDisplayDate(iso);
}

export const PANEL_TH = 'px-4 py-2 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase';
export const INVOICE_LINK = 'text-teal-500 hover:text-teal-400 hover:underline';
