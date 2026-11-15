/**
 * Waitlist (pages/admin/waitlist/index.tsx): a signup row, the list reply, and the date and turnover formats.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

export type StatusFilter = 'pending' | 'promoted' | 'all';

export interface WaitlistRow {
  id: string;
  name: string | null;
  email: string;
  signup_type: 'direct' | 'accountant';
  company_name: string | null;
  practice_name: string | null;
  phone: string | null;
  annual_turnover_cents: number | null;
  created_at: string;
  promoted_at: string | null;
  promoted_company_id: string | null;
}

export interface ListResponse {
  items: WaitlistRow[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export const TURNOVER_THRESHOLD_CENTS = 100_000_000;

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : formatDisplayDate(d);
}

export function fmtTurnover(cents: number | null): string {
  if (cents === null) return '—';
  return formatMoney(cents / 100, { decimals: 0 });
}
