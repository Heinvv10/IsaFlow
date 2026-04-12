/**
 * CompanyBillingTab — Subscription plan, MRR, renewal date, invoice history.
 * Used inside pages/admin/companies/[id].tsx billing tab.
 * Sub-components and types live in BillingTabParts.tsx.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { Loader2, AlertCircle } from 'lucide-react';
import {
  type Subscription,
  type Invoice,
  type PaginatedSubscriptions,
  type PaginatedInvoices,
  SubscriptionCard,
  InvoiceTable,
  NoSubscription,
} from './BillingTabParts';

interface Props {
  companyId: string;
}

export function CompanyBillingTab({ companyId }: Props) {
  const [subscription, setSubscription]         = useState<Subscription | null>(null);
  const [invoices, setInvoices]                 = useState<Invoice[]>([]);
  const [loading, setLoading]                   = useState(true);
  const [invoicesLoading, setInvoicesLoading]   = useState(false);
  const [error, setError]                       = useState('');
  const [actionError, setActionError]           = useState('');
  const [cancelOpen, setCancelOpen]             = useState(false);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(true);
  const [cancelLoading, setCancelLoading]       = useState(false);

  const loadSubscription = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch(
        `/api/admin/billing/subscriptions?company_id=${encodeURIComponent(companyId)}&limit=1`
      );
      const json = await res.json() as { data: PaginatedSubscriptions };
      if (!res.ok) throw new Error((json as unknown as { message: string }).message || 'Failed to load subscription');
      const items = json.data?.items ?? [];
      setSubscription(items.length > 0 ? (items[0] ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load subscription');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const res  = await apiFetch(
        `/api/admin/billing/invoices?company_id=${encodeURIComponent(companyId)}&limit=10&sort_by=created_at&sort_dir=desc`
      );
      const json = await res.json() as { data: PaginatedInvoices };
      if (res.ok) setInvoices(json.data?.items ?? []);
    } catch { /* non-critical — show empty table */ }
    finally { setInvoicesLoading(false); }
  }, [companyId]);

  useEffect(() => {
    void loadSubscription();
    void loadInvoices();
  }, [loadSubscription, loadInvoices]);

  async function handleCancel() {
    if (!subscription) return;
    setCancelLoading(true);
    setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/billing/subscriptions/${subscription.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          cancelAtPeriodEnd
            ? { cancel_at_period_end: true }
            : { status: 'cancelled' }
        ),
      });
      const json = await res.json() as { message?: string };
      if (!res.ok) throw new Error(json.message || 'Cancel failed');
      setCancelOpen(false);
      await loadSubscription();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancelLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {[error, actionError].filter(Boolean).map((msg, i) => (
        <div key={i} className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {msg}
        </div>
      ))}

      {subscription ? (
        <SubscriptionCard
          subscription={subscription}
          onCancel={() => setCancelOpen(true)}
          onRefresh={() => void loadSubscription()}
        />
      ) : (
        <NoSubscription companyId={companyId} />
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Invoice History</h3>
          <span className="text-xs text-gray-400">Last 10</span>
        </div>
        {invoicesLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-teal-500" />
          </div>
        ) : (
          <InvoiceTable invoices={invoices} />
        )}
      </div>

      <ConfirmModal
        open={cancelOpen}
        title="Cancel Subscription"
        message="Choose how to cancel this subscription."
        confirmLabel="Confirm Cancel"
        confirmClass="bg-red-500 hover:bg-red-600"
        loading={cancelLoading}
        onConfirm={() => void handleCancel()}
        onCancel={() => setCancelOpen(false)}
      >
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="cancel_type" checked={cancelAtPeriodEnd}
              onChange={() => setCancelAtPeriodEnd(true)} className="accent-teal-500" />
            <span className="text-gray-700 dark:text-gray-300">Cancel at end of billing period</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="cancel_type" checked={!cancelAtPeriodEnd}
              onChange={() => setCancelAtPeriodEnd(false)} className="accent-red-500" />
            <span className="text-gray-700 dark:text-gray-300">Cancel immediately</span>
          </label>
        </div>
      </ConfirmModal>
    </div>
  );
}
