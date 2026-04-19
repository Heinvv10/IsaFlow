/**
 * Time Entry Approvals Page
 * Route: /accounting/practice/approvals
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { PracticeTimeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';
import type { PracticeClient } from '@/modules/accounting/services/practice/practiceClientService';

// ---------- helpers ----------

function fmtDate(iso: string) {
  return iso ? new Date(iso).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
function fmtMoney(n: number | null) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}
function shortId(uuid: string) { return uuid.slice(0, 8); }

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2.5 px-3 text-sm text-[var(--ff-text-secondary)]';
const SEL_CLS = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/40';
const INPUT_CLS = `${SEL_CLS} w-36`;

function ErrBanner({ msg }: { msg: string }) {
  return <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm"><AlertCircle className="h-4 w-4 shrink-0" /><span>{msg}</span></div>;
}

// ---------- page ----------

type Filters = { userId: string; practiceClientId: string; dateFrom: string; dateTo: string };
const EMPTY_FILTERS: Filters = { userId: '', practiceClientId: '', dateFrom: '', dateTo: '' };

export default function ApprovalsPage() {
  const [entries, setEntries] = useState<PracticeTimeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [clients, setClients] = useState<PracticeClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadEntries = useCallback(async (f: Filters) => {
    setLoading(true); setLoadError(null);
    try {
      const params = new URLSearchParams({ status: 'submitted' });
      if (f.userId) params.set('userId', f.userId);
      if (f.practiceClientId) params.set('practiceClientId', f.practiceClientId);
      if (f.dateFrom) params.set('dateFrom', f.dateFrom);
      if (f.dateTo) params.set('dateTo', f.dateTo);
      const res = await apiFetch(`/api/accounting/practice/time-entries?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      type ListJson = { data?: { entries: PracticeTimeEntry[]; total: number } } | { entries: PracticeTimeEntry[]; total: number };
      const json = (await res.json()) as ListJson;
      const data = 'data' in json && json.data ? json.data : (json as { entries: PracticeTimeEntry[]; total: number });
      setEntries(data.entries ?? []); setTotal(data.total ?? 0); setSelected(new Set());
    } catch (err) { setLoadError(err instanceof Error ? err.message : 'Failed to load entries'); }
    finally { setLoading(false); }
  }, []);

  const loadClients = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/practice/clients?status=active');
      if (!res.ok) return;
      const json = (await res.json()) as { data?: PracticeClient[] } | PracticeClient[];
      setClients(Array.isArray(json) ? json : (json.data ?? []));
    } catch (_err) { /* non-fatal — filter dropdown just won't populate */ }
  }, []);

  useEffect(() => {
    void loadClients();
    void loadEntries(EMPTY_FILTERS);
  }, [loadClients, loadEntries]);

  function applyFilter(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    void loadEntries(next);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    void loadEntries(EMPTY_FILTERS);
  }

  // distinct submitter user IDs from loaded entries (in-memory)
  const submitterIds = Array.from(new Set(entries.map((e) => e.userId)));

  const allChecked = entries.length > 0 && selected.size === entries.length;
  const someChecked = selected.size > 0 && selected.size < entries.length;

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(entries.map((e) => e.id)));
  }
  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleApprove() {
    if (selected.size === 0) return;
    setApproving(true); setApproveError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/time-entries/approve', { method: 'POST', body: JSON.stringify({ ids: Array.from(selected) }) });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const n = selected.size;
      setToast(`Approved ${n} entr${n === 1 ? 'y' : 'ies'}`);
      await loadEntries(filters);
    } catch (err) { setApproveError(err instanceof Error ? err.message : 'Approval failed'); }
    finally { setApproving(false); }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CheckCircle className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Time Entry Approvals</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Review and approve submitted time entries</p>
              </div>
            </div>
            <button
              disabled={selected.size === 0 || approving}
              onClick={() => void handleApprove()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {approving && <Loader2 className="h-4 w-4 animate-spin" />}
              Approve selected{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 max-w-7xl">
          {toast && <div className="flex items-center justify-between p-3 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-300 text-sm"><span>{toast}</span><button onClick={() => setToast(null)} className="ml-4 text-teal-400 hover:text-teal-200 text-lg leading-none">×</button></div>}
          {approveError && <ErrBanner msg={approveError} />}

          {/* filters */}
          <div className="flex flex-wrap items-end gap-3 p-4 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Submitter</label>
              <select value={filters.userId} onChange={(e) => applyFilter({ userId: e.target.value })} className={SEL_CLS}>
                <option value="">All submitters</option>
                {submitterIds.map((id) => <option key={id} value={id}>{shortId(id)}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Client</label>
              <select value={filters.practiceClientId} onChange={(e) => applyFilter({ practiceClientId: e.target.value })} className={SEL_CLS}>
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.legalName}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Date from</label>
              <input type="date" value={filters.dateFrom} onChange={(e) => applyFilter({ dateFrom: e.target.value })} className={INPUT_CLS} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Date to</label>
              <input type="date" value={filters.dateTo} onChange={(e) => applyFilter({ dateTo: e.target.value })} className={INPUT_CLS} />
            </div>
            <button onClick={clearFilters} className="px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
              Clear
            </button>
            {!loading && <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{total} entr{total !== 1 ? 'ies' : 'y'} found</span>}
          </div>

          {/* load error */}
          {loadError && <ErrBanner msg={loadError} />}

          {/* table */}
          {loading ? (
            <div className="flex items-center gap-2 py-16 justify-center text-[var(--ff-text-tertiary)] text-sm">
              <Loader2 className="h-5 w-5 animate-spin" />Loading submitted entries…
            </div>
          ) : entries.length === 0 ? (
            <p className="py-16 text-center text-[var(--ff-text-tertiary)] text-sm">No submitted time entries found.</p>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--ff-bg-tertiary)]">
                    <th className="py-2 px-3 w-8">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => { if (el) el.indeterminate = someChecked; }}
                        onChange={toggleAll}
                        className="h-4 w-4 rounded accent-teal-500 cursor-pointer"
                      />
                    </th>
                    <th className={TH}>Submitter</th>
                    <th className={TH}>Date</th>
                    <th className={TH}>Client</th>
                    <th className={TH}>Category / Work Item</th>
                    <th className={TH}>Description</th>
                    <th className={`${TH} text-right`}>Hrs</th>
                    <th className={`${TH} text-right`}>Rate</th>
                    <th className={`${TH} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => toggleRow(e.id)}
                      className="border-t border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)]/50 cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3">
                        <input type="checkbox" readOnly checked={selected.has(e.id)} className="h-4 w-4 rounded accent-teal-500 cursor-pointer" />
                      </td>
                      <td className={TD}><span className="font-mono text-xs">{shortId(e.userId)}</span></td>
                      <td className={TD}>{fmtDate(e.entryDate)}</td>
                      <td className={TD}>{e.practiceClientName ?? '—'}</td>
                      <td className={TD}>
                        {e.jobCategoryName ?? '—'}
                        {e.workItemName && <span className="text-[var(--ff-text-tertiary)]"> / {e.workItemName}</span>}
                      </td>
                      <td className={`${TD} max-w-xs truncate`}>{e.taskDescription}</td>
                      <td className={`${TD} text-right tabular-nums`}>{e.hours.toFixed(2)}h</td>
                      <td className={`${TD} text-right tabular-nums`}>{fmtMoney(e.appliedRate)}</td>
                      <td className={`${TD} text-right tabular-nums font-medium text-[var(--ff-text-primary)]`}>{fmtMoney(e.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
