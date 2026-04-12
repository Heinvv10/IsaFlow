/** Admin Trial Management — full lifecycle view. /admin/trials */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { AlertCircle, Loader2, Clock, CheckCircle, TrendingUp, XCircle } from 'lucide-react';
import Link from 'next/link';
import { ConvertTrialModal } from '@/components/admin/ConvertTrialModal';

/* ------------------------------------------------------------------ types */
interface TrialCompany {
  id: string;
  name: string;
  plan_name: string | null;
  trial_ends_at: string;
  trial_started_at: string | null;
  user_count: number;
  status: string;
  days_left: number;
}

interface TrialStats {
  total_trials: number;
  expiring_this_week: number;
  expired_unpaid: number;
  converted_this_month: number;
  conversion_rate_percent: number;
}

interface ApiTrialsResponse { data: TrialCompany[] }
interface ApiStatsResponse  { data: TrialStats }
type FilterTab = 'all' | 'expiring' | 'expired' | 'converted';

/* --------------------------------------------------------------- helpers */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function daysLeftBadge(days: number) {
  if (days <= 0)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-700 text-gray-300">Expired</span>;
  if (days <= 2)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/20 text-red-400">{days}d left</span>;
  if (days <= 5)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/20 text-orange-400">{days}d left</span>;
  if (days <= 7)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400">{days}d left</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-500/20 text-green-400">{days}d left</span>;
}

/* ================================================================ Page === */
export default function AdminTrialsPage() {
  const adminHref = useAdminHref();

  const [trials, setTrials]         = useState<TrialCompany[]>([]);
  const [stats, setStats]           = useState<TrialStats | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [tab, setTab]               = useState<FilterTab>('all');
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [extending, setExtending]   = useState<Set<string>>(new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [convertTarget, setConvertTarget] = useState<TrialCompany | null>(null);

  /* ----------------------------------------------------------- load data */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [trialsRes, statsRes] = await Promise.all([
        apiFetch('/api/admin/trials?within=365'),
        apiFetch('/api/admin/trials/stats'),
      ]);
      const trialsJson = await trialsRes.json() as ApiTrialsResponse;
      const statsJson  = await statsRes.json() as ApiStatsResponse;
      if (!trialsRes.ok) throw new Error('Failed to load trials');
      setTrials(trialsJson.data ?? []);
      if (statsRes.ok) setStats(statsJson.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trials');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* ------------------------------------------------------------ filter */
  const filtered = useMemo<TrialCompany[]>(() => {
    switch (tab) {
      case 'expiring':  return trials.filter((t) => t.days_left > 0 && t.days_left <= 7);
      case 'expired':   return trials.filter((t) => t.days_left <= 0 && t.status !== 'active');
      case 'converted': return trials.filter((t) => t.status === 'active');
      default:          return trials;
    }
  }, [trials, tab]);

  /* --------------------------------------------------- single extend */
  const extendOne = useCallback(async (id: string, days: number) => {
    setExtending((prev) => new Set(prev).add(id));
    try {
      const res  = await apiFetch('/api/admin/trials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: id, days }),
      });
      if (!res.ok) throw new Error('Extend failed');
      await load();
    } catch {
      setError(`Failed to extend trial for company ${id}`);
    } finally {
      setExtending((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [load]);

  /* ---------------------------------------------------- bulk extend */
  const bulkExtend = useCallback(async () => {
    if (selected.size === 0) return;
    setBulkWorking(true);
    try {
      const res = await apiFetch('/api/admin/trials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_ids: Array.from(selected), days: 7 }),
      });
      if (!res.ok) throw new Error('Bulk extend failed');
      setSelected(new Set());
      await load();
    } catch {
      setError('Bulk extend failed');
    } finally {
      setBulkWorking(false);
    }
  }, [selected, load]);

  /* --------------------------------------------------- select helpers */
  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((t) => t.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  /* -------------------------------------------------------------- tabs */
  const TABS: { id: FilterTab; label: string }[] = [
    { id: 'all',       label: 'All Trials' },
    { id: 'expiring',  label: 'Expiring Soon' },
    { id: 'expired',   label: 'Expired' },
    { id: 'converted', label: 'Converted' },
  ];

  /* ============================================================= render */
  return (
    <AdminLayout title="Trial Management">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {!loading && (
        <>
          {/* ---- Summary Stats ---- */}
          {stats && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              {([
                ['Total Trials',        stats.total_trials,                    Clock,       'text-blue-400'],
                ['Expiring This Week',  stats.expiring_this_week,              AlertCircle, 'text-yellow-400'],
                ['Expired (Unpaid)',    stats.expired_unpaid,                  XCircle,     'text-red-400'],
                ['Converted (30d)',     stats.converted_this_month,            CheckCircle, 'text-green-400'],
                ['Conversion Rate',     `${stats.conversion_rate_percent}%`,   TrendingUp,  'text-teal-400'],
              ] as const).map(([label, value, Icon, colour]) => (
                <div key={label} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 flex flex-col gap-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={`w-4 h-4 ${colour}`} />
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wider">{label}</p>
                  </div>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* ---- Filter Tabs ---- */}
          <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-700">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setSelected(new Set()); }}
                className={[
                  'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                  tab === t.id
                    ? 'border-teal-500 text-teal-500'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ---- Bulk Action Bar ---- */}
          {selected.size > 0 && (
            <div className="flex items-center gap-3 mb-4 px-4 py-2 bg-teal-500/10 border border-teal-500/30 rounded-lg">
              <span className="text-sm text-teal-400 font-medium">{selected.size} selected</span>
              <button
                onClick={() => void bulkExtend()}
                disabled={bulkWorking}
                className="inline-flex items-center gap-2 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {bulkWorking && <Loader2 className="w-3 h-3 animate-spin" />}
                Extend 7 days
              </button>
              <button onClick={() => setSelected(new Set())} className="text-xs text-gray-400 hover:text-gray-200">Clear</button>
            </div>
          )}

          {/* ---- Table ---- */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-4 py-3"><input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} className="rounded" /></th>
                  {['Company','Plan','Started','Expires','Days Left','Status','Users','Actions'].map((h) => (
                    <th key={h} className="px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-gray-400">No trials in this category</td>
                  </tr>
                )}
                {filtered.map((trial) => (
                  <tr key={trial.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(trial.id)} onChange={() => toggleOne(trial.id)} className="rounded" />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{trial.name}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{trial.plan_name ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{trial.trial_started_at ? fmtDate(trial.trial_started_at) : '—'}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(trial.trial_ends_at)}</td>
                    <td className="px-4 py-3">{daysLeftBadge(trial.days_left)}</td>
                    <td className="px-4 py-3">
                      <span className={[
                        'px-2 py-0.5 rounded-full text-xs font-medium',
                        trial.status === 'active' ? 'bg-green-500/15 text-green-400' : 'bg-gray-700/50 text-gray-400',
                      ].join(' ')}>
                        {trial.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{trial.user_count}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => void extendOne(trial.id, 7)}
                          disabled={extending.has(trial.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-teal-600/20 hover:bg-teal-600/40 text-teal-400 rounded-md transition-colors disabled:opacity-40"
                        >
                          {extending.has(trial.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          +7 days
                        </button>
                        {trial.status !== 'active' && (
                          <button
                            onClick={() => setConvertTarget(trial)}
                            className="px-2.5 py-1 text-xs bg-green-600/20 hover:bg-green-600/40 text-green-400 rounded-md transition-colors"
                          >
                            Convert to Paid
                          </button>
                        )}
                        <Link
                          href={adminHref(`/admin/companies/${trial.id}`)}
                          className="px-2.5 py-1 text-xs bg-gray-700/40 hover:bg-gray-700/70 text-gray-300 rounded-md transition-colors"
                        >
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {convertTarget && (
        <ConvertTrialModal
          companyId={convertTarget.id}
          companyName={convertTarget.name}
          onClose={() => setConvertTarget(null)}
          onConverted={() => { setConvertTarget(null); void load(); }}
        />
      )}
    </AdminLayout>
  );
}
