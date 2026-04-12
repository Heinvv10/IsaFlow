/**
 * BillingTabParts — Sub-components for CompanyBillingTab.
 * Split out to keep CompanyBillingTab under 300 lines.
 */

import { useState } from 'react';
import { formatDate } from '@/utils/formatters';
import { Loader2, CreditCard, XCircle, PlusCircle, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Shared types (exported so CompanyBillingTab can import them)
// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  company_id: string;
  company_name: string;
  plan_id: string;
  plan_name: string;
  plan_code: string;
  status: string;
  billing_cycle: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  discount_percent: number;
  monthly_amount_cents: number;
  created_at: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface PaginatedSubscriptions {
  items: Subscription[];
  total: number;
}

export interface PaginatedInvoices {
  items: Invoice[];
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function centsToZar(cents: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);
}

export const SUB_STATUS_CLASS: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  past_due:  'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  cancelled: 'bg-gray-500/10 text-gray-500',
  suspended: 'bg-red-500/10 text-red-500',
};

export const INV_STATUS_CLASS: Record<string, string> = {
  draft:   'bg-gray-500/10 text-gray-500',
  sent:    'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  paid:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  overdue: 'bg-red-500/10 text-red-500',
  void:    'bg-gray-500/10 text-gray-400',
};

// ---------------------------------------------------------------------------
// Shared UI atoms
// ---------------------------------------------------------------------------

export function StatusBadge({ status, map }: { status: string; map: Record<string, string> }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${map[status] ?? 'bg-gray-500/10 text-gray-500'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

export function BillingField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">{label}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubscriptionCard
// ---------------------------------------------------------------------------

export function SubscriptionCard({
  subscription,
  onCancel,
  onRefresh,
}: {
  subscription: Subscription;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const isCancellable = ['active', 'trial', 'past_due'].includes(subscription.status);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-teal-500/10 rounded-lg">
            <CreditCard className="w-5 h-5 text-teal-500" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{subscription.plan_name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 capitalize">{subscription.billing_cycle} billing</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onRefresh} title="Refresh"
            className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isCancellable && (
            <button onClick={onCancel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">
              <XCircle className="w-3.5 h-3.5" /> Cancel Subscription
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <BillingField label="Status">
          <StatusBadge status={subscription.status} map={SUB_STATUS_CLASS} />
        </BillingField>
        <BillingField label="MRR Contribution">
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            {centsToZar(subscription.monthly_amount_cents)}
          </span>
        </BillingField>
        <BillingField label="Discount">
          <span className="text-sm text-gray-900 dark:text-white">
            {subscription.discount_percent > 0 ? `${subscription.discount_percent}%` : '—'}
          </span>
        </BillingField>
        <BillingField label="Period Start">
          <span className="text-sm text-gray-900 dark:text-white">
            {formatDate(subscription.current_period_start)}
          </span>
        </BillingField>
        <BillingField label="Next Renewal">
          <span className="text-sm text-gray-900 dark:text-white">
            {subscription.cancel_at_period_end
              ? <span className="text-red-500">Cancels {formatDate(subscription.current_period_end)}</span>
              : formatDate(subscription.current_period_end)}
          </span>
        </BillingField>
        <BillingField label="Subscribed">
          <span className="text-sm text-gray-900 dark:text-white">
            {formatDate(subscription.created_at)}
          </span>
        </BillingField>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InvoiceTable
// ---------------------------------------------------------------------------

export function InvoiceTable({ invoices }: { invoices: Invoice[] }) {
  if (invoices.length === 0) {
    return <div className="px-4 py-10 text-center text-sm text-gray-400">No invoices found.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
            <th className="px-4 py-3 font-medium">Invoice #</th>
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Due</th>
            <th className="px-4 py-3 font-medium text-right">Amount</th>
            <th className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map(inv => (
            <tr key={inv.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
              <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">{inv.invoice_number}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{formatDate(inv.created_at)}</td>
              <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{formatDate(inv.due_date)}</td>
              <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-white">{centsToZar(inv.total_cents)}</td>
              <td className="px-4 py-3"><StatusBadge status={inv.status} map={INV_STATUS_CLASS} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NoSubscription
// ---------------------------------------------------------------------------

export function NoSubscription({ companyId }: { companyId: string }) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  function handleCreate() {
    setCreating(true);
    setCreateError('');
    try {
      window.location.href = `/admin/billing/subscriptions/new?companyId=${encodeURIComponent(companyId)}`;
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Navigation failed');
      setCreating(false);
    }
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-10 text-center">
      <CreditCard className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">No active subscription</p>
      <p className="text-xs text-gray-400 mb-4">This company has no subscription linked to a billing plan.</p>
      {createError && <p className="text-xs text-red-500 mb-3">{createError}</p>}
      <button onClick={handleCreate} disabled={creating}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-teal-500 hover:bg-teal-600 text-white transition-colors disabled:opacity-50">
        {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
        Create Subscription
      </button>
    </div>
  );
}
