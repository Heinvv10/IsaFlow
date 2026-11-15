/**
 * Subscriptions (pages/admin/billing/subscriptions.tsx): a row of the list, a plan option, and the Add form.
 */
export interface Subscription {
  id: string;
  company_id: string;
  company_name: string;
  plan_id: string;
  plan_name: string;
  plan_code: string;
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'paused';
  billing_cycle: string;
  discount_percent: number;
  monthly_amount_cents: number;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
}

export interface Plan {
  id: string;
  name: string;
  code: string;
}

export interface PagedResponse {
  items: Subscription[];
  total: number;
  page: number;
  limit: number;
}

export interface SubForm {
  company_id: string;
  plan_id: string;
  billing_cycle: string;
  discount_pct: string;
}

export const EMPTY_FORM: SubForm = { company_id: '', plan_id: '', billing_cycle: 'monthly', discount_pct: '0' };

export const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  past_due:  'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-ink-faint dark:text-gray-500',
  paused:    'bg-blue-500/10 text-blue-400',
};
