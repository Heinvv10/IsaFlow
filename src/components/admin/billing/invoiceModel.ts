/** Admin invoice list: row and form shapes, empty form and status badge classes. */

export interface Invoice {
  id: string;
  invoice_number: string;
  company_id: string;
  company_name: string;
  /** Where a Send goes; null when the company has none (the server then refuses the send). */
  billing_email?: string | null;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'credited';
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  due_date: string | null;
  paid_at: string | null;
  payment_method: string | null;
  created_at: string;
  /** A Send in flight or with an unknown outcome (migration 993): no Send button; settle it instead. */
  send_claimed_at?: string | null;
}

export interface PagedResponse {
  items: Invoice[];
  total: number;
  page: number;
  limit: number;
}

/** The create form: rands as typed. VAT and total are not inputs; the server computes them (invoiceAmounts.ts). */
export interface InvForm {
  company_id: string;
  subtotal: string;
  due_date: string;
  notes: string;
}

export const EMPTY_FORM: InvForm = { company_id: '', subtotal: '', due_date: '', notes: '' };
