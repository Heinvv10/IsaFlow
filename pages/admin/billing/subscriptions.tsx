/**
 * Admin — Subscription List
 * Filter, search, paginate subscriptions; add new subscription.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { AdminPager } from '@/components/admin/AdminPager';
import { AddSubscriptionModal } from '@/components/admin/billing/AddSubscriptionModal';
import { EMPTY_FORM, STATUS_BADGE, type PagedResponse, type Plan, type SubForm, type Subscription } from '@/components/admin/billing/subscriptionModel';
import { assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { adminExportHref } from '@/components/admin/adminExportHref';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { AlertCircle, Loader2, Search, Plus, Check, Ban, Download } from 'lucide-react';
import { adminFetch } from '@/lib/admin/adminFetch';


export default function SubscriptionsPage() {
  const adminHref = useAdminHref();
  const router = useRouter();
  const [rows, setRows]         = useState<Subscription[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [status, setStatus]     = useState('');
  const [plans, setPlans]       = useState<Plan[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState<SubForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [companyNamed, setCompanyNamed] = useState(false);
  const [saving, setSaving]     = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  useFocusTrap(formRef, showForm, () => { if (!saving) setShowForm(false); }); // audit 4.13; not mid-request
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling]           = useState(false);
  const [cancelError, setCancelError]         = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIMIT = 25;
  void adminHref; // used for future navigation

  const load = useCallback(async (q: string, st: string, pg: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(LIMIT) });
      if (q) params.set('search', q); if (st) params.set('status', st);
      const res  = await adminFetch(`/api/admin/billing/subscriptions?${params}`);
      await assertOk(res, 'Could not load subscriptions - try again');
      const json = await res.json();
      const d = json.data as PagedResponse;
      setRows(d.items); setTotal(d.total);
    } catch (err) {
      setRows([]); setTotal(0);
      setError(apiErrorMessage(err, 'Could not load subscriptions - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPlans = useCallback(async () => {
    try {
      const res  = await adminFetch('/api/admin/billing/plans'); await assertOk(res, 'Could not load the plans');
      const json = await res.json();
      setPlans((json.data ?? []) as Plan[]);
    } catch (err) { log.warn('Failed to load billing plans', { err }, 'admin-subscriptions'); }
  }, []);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

  // Company Billing tab's "Create Subscription" lands here with ?companyId= — open the form prefilled,
  // then drop the param so a refresh doesn't reopen it.
  useEffect(() => {
    const cid = router.query.companyId;
    if (!router.isReady || typeof cid !== 'string' || !cid) return;
    setForm({ ...EMPTY_FORM, company_id: cid }); setFormError(''); setShowForm(true);
    void router.replace(router.pathname, undefined, { shallow: true });
  }, [router.isReady, router.query.companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      void load(search, status, 1);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, status, load]);

  useEffect(() => { void load(search, status, page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  async function handleAdd() {
    setFormError('');
    if (!form.company_id) { setFormError('Company is required'); return; }
    if (!companyNamed)    { setFormError('Company is still loading'); return; }
    if (!form.plan_id)           { setFormError('Plan is required'); return; }
    setSaving(true);
    try {
      const res  = await adminFetch('/api/admin/billing/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id:    form.company_id,
          plan_id:       form.plan_id,
          billing_cycle: form.billing_cycle,
          discount_percent: parseFloat(form.discount_pct) || 0,
        }),
      });
      await assertOk(res, 'Could not create the subscription - try again');
      setShowForm(false);
      setForm(EMPTY_FORM);
      void load(search, status, 1);
    } catch (err) {
      setFormError(apiErrorMessage(err, 'Could not create the subscription - try again'));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel(id: string) {
    setCancelling(true);
    setCancelError('');
    try {
      const res  = await adminFetch(`/api/admin/billing/subscriptions/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at_period_end: false }) });
      await assertOk(res, 'Could not cancel the subscription - try again');
      setConfirmCancelId(null);
      void load(search, status, page);
    } catch (err) {
      setCancelError(apiErrorMessage(err, 'Could not cancel the subscription - try again'));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <AdminLayout title="Subscriptions">
      {/* Toolbar */}
      <div className="flex gap-3 flex-wrap mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 dark:text-gray-400" />
          <input type="text" placeholder="Search company..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500" />
        </div>
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
          <option value="">All statuses</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="past_due">Past Due</option>
          <option value="cancelled">Cancelled</option>
          <option value="paused">Paused</option>
        </select>
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center">{total} total</span>
        <a
          href={adminExportHref('/api/admin/billing/subscriptions/export', { search, status })}
          download
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <Download className="w-4 h-4" /> Export CSV
        </a>
        <button onClick={() => { setShowForm(true); setFormError(''); setForm(EMPTY_FORM); }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors">
          <Plus className="w-4 h-4" /> Add Subscription
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}
      {cancelError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {cancelError}
        </div>
      )}

      {/* Add Subscription Modal */}
      {showForm && (
        <AddSubscriptionModal
          formRef={formRef}
          form={form}
          setForm={setForm}
          formError={formError}
          plans={plans}
          saving={saving}
          setCompanyNamed={setCompanyNamed}
          onClose={() => setShowForm(false)}
          onCreate={() => void handleAdd()}
        />
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Cycle</th>
                <th className="px-4 py-3 font-medium">Discount</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Period End</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" /></td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-600 dark:text-gray-400">No subscriptions found</td></tr>
              )}
              {rows.map(s => {
                const canCancel = s.status === 'active' || s.status === 'trial';
                const isConfirming = confirmCancelId === s.id;
                return (
                  <tr key={s.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{s.company_name}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.plan_name}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[s.status] ?? 'bg-gray-500/10 text-gray-500'}`}>
                        {s.status.replaceAll('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{s.billing_cycle}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.discount_percent > 0 ? `${s.discount_percent}%` : '\u2014'}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs">{formatCurrency(s.monthly_amount_cents / 100)}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(s.current_period_end)}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(s.created_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {canCancel && !isConfirming && (
                        <button
                          onClick={() => { setCancelError(''); setConfirmCancelId(s.id); }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-400 border border-red-500/40 rounded hover:bg-red-500/10 transition-colors"
                        >
                          <Ban className="w-3 h-3" /> Cancel
                        </button>
                      )}
                      {canCancel && isConfirming && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-500 dark:text-gray-400">Confirm?</span>
                          <button
                            onClick={() => void handleCancel(s.id)}
                            disabled={cancelling}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-50 transition-colors"
                          >
                            {cancelling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Yes
                          </button>
                          <button
                            onClick={() => { setConfirmCancelId(null); setCancelError(''); }}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                          >
                            No
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <AdminPager page={page} totalPages={totalPages} setPage={setPage} />
      </div>
    </AdminLayout>
  );
}
