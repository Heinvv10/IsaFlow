/**
 * Admin — Subscription List
 * Filter, search, paginate subscriptions; add new subscription.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, Search, ChevronLeft, ChevronRight, Plus, X, Check } from 'lucide-react';

interface Subscription {
  id: string;
  companyId: string;
  companyName: string;
  planName: string;
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'paused';
  billingCycle: string;
  discountPct: number;
  amountCents: number;
  periodEnd: string | null;
  createdAt: string;
}

interface Plan {
  id: string;
  name: string;
  code: string;
}

interface PagedResponse {
  items: Subscription[];
  total: number;
  page: number;
  limit: number;
}

interface SubForm {
  company_id: string;
  plan_id: string;
  billing_cycle: string;
  discount_pct: string;
}

const EMPTY_FORM: SubForm = { company_id: '', plan_id: '', billing_cycle: 'monthly', discount_pct: '0' };

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  past_due:  'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
  paused:    'bg-blue-500/10 text-blue-400',
};

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-ZA');
}

export default function SubscriptionsPage() {
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
  const [saving, setSaving]     = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIMIT = 25;

  const load = useCallback(async (q: string, st: string, pg: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(LIMIT) });
      if (q)  params.set('search', q);
      if (st) params.set('status', st);
      const res  = await apiFetch(`/api/admin/billing/subscriptions?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load subscriptions');
      const d = json.data as PagedResponse;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPlans = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/admin/billing/plans');
      const json = await res.json();
      if (res.ok) setPlans((json.data ?? []) as Plan[]);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

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
    if (!form.company_id.trim()) { setFormError('Company ID is required'); return; }
    if (!form.plan_id)           { setFormError('Plan is required'); return; }
    setSaving(true);
    try {
      const res  = await apiFetch('/api/admin/billing/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          company_id:    form.company_id,
          plan_id:       form.plan_id,
          billing_cycle: form.billing_cycle,
          discount_pct:  parseFloat(form.discount_pct) || 0,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to create subscription');
      setShowForm(false);
      setForm(EMPTY_FORM);
      void load(search, status, 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminLayout title="Subscriptions">
      {/* Toolbar */}
      <div className="flex gap-3 flex-wrap mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Search company…" value={search} onChange={e => setSearch(e.target.value)}
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
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center ml-auto">{total} total</span>
        <button onClick={() => { setShowForm(true); setFormError(''); setForm(EMPTY_FORM); }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors">
          <Plus className="w-4 h-4" /> Add Subscription
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Add Subscription Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Add Subscription</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-xs">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {formError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Company ID</label>
                <input type="text" value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Plan</label>
                <select value={form.plan_id} onChange={e => setForm(f => ({ ...f, plan_id: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
                  <option value="">Select a plan…</option>
                  {plans.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Billing Cycle</label>
                  <select value={form.billing_cycle} onChange={e => setForm(f => ({ ...f, billing_cycle: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Discount %</label>
                  <input type="number" min="0" max="100" value={form.discount_pct} onChange={e => setForm(f => ({ ...f, discount_pct: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500" />
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
              <button onClick={() => void handleAdd()} disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Create
              </button>
            </div>
          </div>
        </div>
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
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" /></td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">No subscriptions found</td></tr>
              )}
              {rows.map(s => (
                <tr key={s.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{s.companyName}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.planName}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[s.status] ?? 'bg-gray-500/10 text-gray-500'}`}>
                      {s.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{s.billingCycle}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{s.discountPct > 0 ? `${s.discountPct}%` : '—'}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{fmtZAR(s.amountCents)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(s.periodEnd)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
              className="p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
              className="p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
