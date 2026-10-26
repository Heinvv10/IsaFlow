/** Admin invoice list: row and form shapes, empty form and status badge classes. */

export interface Invoice {
  id: string;
  invoice_number: string;
  company_id: string;
  company_name: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'credited';
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  due_date: string | null;
  paid_at: string | null;
  payment_method: string | null;
  created_at: string;
}

export interface PagedResponse {
  items: Invoice[];
  total: number;
  page: number;
  limit: number;
}

export interface InvForm {
  company_id: string;
  subtotal: string;
  tax: string;
  total: string;
  due_date: string;
  notes: string;
}

export const EMPTY_FORM: InvForm = { company_id: '', subtotal: '', tax: '0', total: '', due_date: '', notes: '' };

export const STATUS_BADGE: Record<string, string> = {
  draft:      'bg-gray-500/10 text-gray-500',
  sent:       'bg-blue-500/10 text-blue-400',
  paid:       'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  overdue:    'bg-red-500/10 text-red-500',
  cancelled:  'bg-gray-500/10 text-gray-500',
  credited:   'bg-purple-500/10 text-purple-400',
};
