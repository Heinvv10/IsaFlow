/**
 * Admin — Waitlist
 *
 * Pre-launch signup leads. Lets a platform admin promote a lead into a real
 * `companies` row (with PAYG flags seeded from the declared turnover).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { AlertCircle, Loader2, Search, UserPlus, ExternalLink, X, Check } from 'lucide-react';

type StatusFilter = 'pending' | 'promoted' | 'all';

interface WaitlistRow {
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

interface ListResponse {
  items: WaitlistRow[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

const TURNOVER_THRESHOLD_CENTS = 100_000_000;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: '2-digit' });
}

function fmtTurnover(cents: number | null): string {
  if (cents === null) return '—';
  return `R${(cents / 100).toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
}

export default function AdminWaitlistPage() {
  const adminHref = useAdminHref();

  const [rows, setRows]         = useState<WaitlistRow[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [status, setStatus]     = useState<StatusFilter>('pending');
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState(1);

  const [promoteTarget, setPromoteTarget]   = useState<WaitlistRow | null>(null);
  const [planOverride, setPlanOverride]     = useState<'' | 'payg' | 'starter'>('');
  const [promoting, setPromoting]           = useState(false);
  const [promoteError, setPromoteError]     = useState('');

  const LIMIT = 25;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (s: StatusFilter, q: string, p: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ status: s, page: String(p), limit: String(LIMIT) });
      if (q) params.set('search', q);
      const res  = await apiFetch(`/api/admin/waitlist?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message || 'Failed to load');
      const data = (json as { data: ListResponse }).data;
      setRows(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setPage(1);
      void load(status, search, 1);
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [status, search, load]);

  useEffect(() => {
    void load(status, search, page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function openPromote(row: WaitlistRow) {
    setPromoteTarget(row);
    setPromoteError('');
    const declared = row.annual_turnover_cents;
    if (row.signup_type === 'accountant') {
      setPlanOverride('');
    } else if (declared !== null && declared < TURNOVER_THRESHOLD_CENTS) {
      setPlanOverride('payg');
    } else if (declared !== null) {
      setPlanOverride('starter');
    } else {
      setPlanOverride('');
    }
  }

  async function handlePromote(e: React.FormEvent) {
    e.preventDefault();
    if (!promoteTarget) return;
    setPromoting(true);
    setPromoteError('');
    try {
      const res = await apiFetch(`/api/admin/waitlist/${promoteTarget.id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ planCodeOverride: planOverride || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message || 'Promotion failed');
      const data = (json as { data: { companyId: string | null; status: string } }).data;
      setPromoteTarget(null);
      if (data.companyId) {
        window.location.href = adminHref(`/admin/companies/${data.companyId}`);
        return;
      }
      void load(status, search, page);
    } catch (err) {
      setPromoteError(err instanceof Error ? err.message : 'Promotion failed');
    } finally {
      setPromoting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <AdminLayout title="Waitlist">
      <div className="flex gap-3 flex-wrap mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search name, email, company..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="pending">Pending</option>
          <option value="promoted">Promoted</option>
          <option value="all">All</option>
        </select>
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center">{total} total</span>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-3 font-medium">Signed up</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Name / Email</th>
                <th className="px-4 py-3 font-medium">Company / Practice</th>
                <th className="px-4 py-3 font-medium">Turnover</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" /></td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-600 dark:text-gray-400">No signups found</td></tr>
              )}
              {rows.map((r) => {
                const isPayg = r.signup_type === 'direct' && r.annual_turnover_cents !== null && r.annual_turnover_cents < TURNOVER_THRESHOLD_CENTS;
                return (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${r.signup_type === 'accountant' ? 'bg-indigo-500/10 text-indigo-500' : 'bg-teal-500/10 text-teal-600 dark:text-teal-400'}`}>
                        {r.signup_type === 'accountant' ? 'Bureau' : 'Direct'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{r.name || '—'}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{r.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                      {r.signup_type === 'accountant' ? (r.practice_name || '—') : (r.company_name || '—')}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs whitespace-nowrap">
                      {fmtTurnover(r.annual_turnover_cents)}
                      {isPayg && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-500/10 text-teal-600 dark:text-teal-400">PAYG</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.promoted_at
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-500/10 text-gray-500"><Check className="w-3 h-3" /> Promoted</span>
                        : <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">Pending</span>
                      }
                    </td>
                    <td className="px-4 py-3">
                      {r.promoted_company_id
                        ? <a href={adminHref(`/admin/companies/${r.promoted_company_id}`)} className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline"><ExternalLink className="w-3 h-3" /> View company</a>
                        : <button onClick={() => openPromote(r)} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-teal-600 hover:bg-teal-700 text-white transition-colors"><UserPlus className="w-3 h-3" /> Promote</button>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Prev</button>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Next</button>
          </div>
        </div>
      </div>

      {promoteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Promote waitlist signup</h2>
              <button onClick={() => setPromoteTarget(null)} className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={(e) => void handlePromote(e)} className="p-5 space-y-4 text-sm">
              {promoteError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {promoteError}
                </div>
              )}
              <dl className="grid grid-cols-3 gap-y-1 text-xs">
                <dt className="text-gray-500 dark:text-gray-400">Email</dt>
                <dd className="col-span-2 text-gray-900 dark:text-white break-all">{promoteTarget.email}</dd>
                <dt className="text-gray-500 dark:text-gray-400">{promoteTarget.signup_type === 'accountant' ? 'Practice' : 'Company'}</dt>
                <dd className="col-span-2 text-gray-900 dark:text-white">{promoteTarget.signup_type === 'accountant' ? (promoteTarget.practice_name ?? '—') : (promoteTarget.company_name ?? '—')}</dd>
                <dt className="text-gray-500 dark:text-gray-400">Turnover</dt>
                <dd className="col-span-2 text-gray-900 dark:text-white font-mono">{fmtTurnover(promoteTarget.annual_turnover_cents)}</dd>
              </dl>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Plan</label>
                <select
                  value={planOverride}
                  onChange={(e) => setPlanOverride(e.target.value as '' | 'payg' | 'starter')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">No plan (admin will assign later)</option>
                  <option value="payg">PAYG (Pay-As-You-Go)</option>
                  <option value="starter">Starter</option>
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  PAYG eligibility is auto-computed from declared turnover; override only if you need a different tier.
                </p>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setPromoteTarget(null)} className="px-4 py-2 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
                <button type="submit" disabled={promoting} className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50">
                  {promoting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create company
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
