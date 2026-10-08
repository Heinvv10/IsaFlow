/**
 * Customer invoice types shared between the detail page and its hooks.
 */

import type { DocumentApprovalState } from './approval.types';

export interface CustomerInvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  tax_rate: number;
  /** Migration 870: what the line posts to, named for the approver. Null when uncoded. */
  gl_account_id?: string | null;
  /** Posted invoices: whether its journal credited the line's account (null when unposted or uncoded). */
  account_posted?: boolean | null;
  gl_account_code?: string | null;
  gl_account_name?: string | null;
  project_id?: string | null;
  project_number?: string | null;
  line_project_name?: string | null;
  cost_center_id?: string | null;
  cost_center_code?: string | null;
  cost_center_name?: string | null;
}

export interface CustomerInvoiceDetail {
  id: string;
  invoice_number: string;
  client_name: string;
  project_name: string;
  status: string;
  invoice_date: string;
  due_date: string;
  billing_period_start: string;
  billing_period_end: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  notes: string;
  gl_journal_entry_id: string;
  client_id?: string;
  customer_id?: string;
  client_email?: string;
  email_sent_at?: string;
  email_sent_to?: string;
  online_payment_enabled?: boolean;
  payment_url?: string;
  /** An active, unexpired standing (`charges_balance`) payment link exists, whether or not payment_url names it. The link payment_url names never expires. */
  has_standing_link?: boolean;
  items: CustomerInvoiceItem[];
  /** R-035: the derived approval state while the invoice is a draft or pending approval, else null. */
  approval?: DocumentApprovalState | null;
}

export const CUSTOMER_INVOICE_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  pending_approval: 'bg-amber-500/20 text-amber-400',
  approved: 'bg-blue-500/20 text-blue-400',
  sent: 'bg-indigo-500/20 text-indigo-400',
  paid: 'bg-teal-500/20 text-teal-400',
  partially_paid: 'bg-purple-500/20 text-purple-400',
  overdue: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-500',
};
