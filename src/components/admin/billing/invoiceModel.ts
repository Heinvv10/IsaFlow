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
