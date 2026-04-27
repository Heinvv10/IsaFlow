/**
 * Portfolio Workbench
 * Practice-owner home screen — close-of-month status across all clients.
 *
 * Path: /accounting/portfolio-workbench
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type {
  PortfolioWorkbench,
  PortfolioRow,
} from '@/modules/accounting/services/workbench/portfolioWorkbenchService';
import type { CardStatus } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';

function defaultPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const STATUS_DOT: Record<CardStatus, string> = {
  ready:       'bg-emerald-500',
  in_progress: 'bg-amber-500',
  attention:   'bg-red-500',
  blocked:     'bg-rose-600',
  not_started: 'bg-zinc-600',
};

// Glyph alongside the dot — communicates status to colour-blind users and
// screen readers via aria-label, not by colour alone.
const STATUS_GLYPH: Record<CardStatus, string> = {
  ready:       '✓',
  in_progress: '⏳',
  attention:   '!',
  blocked:     '✗',
  not_started: '⌀',
};

const STATUS_LABEL: Record<CardStatus, string> = {
  ready: 'Ready', in_progress: 'In progress', attention: 'Needs attention', blocked: 'Blocked', not_started: 'Not started',
};

const COLUMN_DEFS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'banking',    label: 'Bank' },
  { id: 'sales',      label: 'AR' },
  { id: 'purchases',  label: 'AP' },
  { id: 'vat',        label: 'VAT' },
  { id: 'payroll',    label: 'Payroll' },
  { id: 'afs',        label: 'AFS' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'review',     label: 'Review' },
];

interface ApiEnvelope<T> { success: boolean; data: T; error?: { message?: string } }

function StatusCell({ row, columnId }: { row: PortfolioRow; columnId: string }) {
  const card = row.cards.find(c => c.id === columnId);
  if (!card) {
    return <td className="px-2 py-2 text-center text-zinc-700">—</td>;
  }
  return (
    <td className="px-2 py-2 text-center">
      <div
        className="flex items-center justify-center gap-1.5"
        title={`${STATUS_LABEL[card.status]} · ${card.primary}`}
      >
        <span className={`w-2 h-2 rounded-full ${STATUS_DOT[card.status]}`} aria-hidden="true" />
        <span className="text-xs text-zinc-300 font-mono" aria-label={STATUS_LABEL[card.status]}>
          {STATUS_GLYPH[card.status]}
        </span>
      </div>
    </td>
  );
}

function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
      {(['ready', 'in_progress', 'attention', 'blocked', 'not_started'] as CardStatus[]).map(s => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${STATUS_DOT[s]}`} aria-hidden="true" />
          <span className="font-mono" aria-hidden="true">{STATUS_GLYPH[s]}</span>
          {STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

export default function PortfolioWorkbenchPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<string>(defaultPeriod());
  const [data, setData] = useState<PortfolioWorkbench | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);

  const openClientWorkbench = useCallback(async (companyId: string) => {
    // Switch active company server-side first (sets the cookie + verifies
    // membership), THEN navigate. The per-client workbench reads the cookie,
    // so without the switch it would just show the previous active client.
    setSwitching(companyId);
    try {
      const res = await apiFetch('/api/auth/switch-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? `Switch failed (${res.status})`);
      }
      await router.push(`/accounting/month-end-workbench?period=${encodeURIComponent(period)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch company');
      setSwitching(null);
    }
  }, [period, router]);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/portfolio-workbench?period=${encodeURIComponent(p)}`);
      const json = await res.json() as ApiEnvelope<PortfolioWorkbench>;
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message ?? 'Failed to load portfolio');
      }
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(period); }, [period, load]);

  const filteredRows = data?.rows.filter(r =>
    !search || r.companyName.toLowerCase().includes(search.toLowerCase()),
  ) ?? [];

  return (
    <AppLayout>
      <div className="px-6 py-6 max-w-7xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-100">Portfolio</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Month-end status across every client — {periodLabel(period)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter clients…"
              aria-label="Filter clients"
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-md px-3 py-1.5 w-48 focus:outline-none focus:border-teal-500"
            />
            <label htmlFor="portfolio-period" className="sr-only">Period</label>
            <input
              id="portfolio-period"
              type="month"
              value={period}
              onChange={e => setPeriod(e.target.value)}
              aria-label="Period"
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-md px-3 py-1.5 focus:outline-none focus:border-teal-500"
            />
          </div>
        </div>

        {data && (
          <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm text-zinc-300">
              <span className="font-medium text-zinc-100">{data.summary.clientsAtRisk}</span> of <span className="font-medium">{data.summary.totalClients}</span> clients need attention this period
            </div>
            <StatusLegend />
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-20 text-zinc-400">
            <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading portfolio…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {data && !loading && filteredRows.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-zinc-400">
            {search
              ? `No clients match "${search}".`
              : data.rows.length === 0
                ? "No clients in your portfolio yet."
                : "No clients match the current filter."}
          </div>
        )}

        {data && !loading && filteredRows.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5 sticky top-0">Client</th>
                  <th className="text-center font-medium px-2 py-2.5 sticky top-0">TB</th>
                  {COLUMN_DEFS.map(col => (
                    <th key={col.id} className="text-center font-medium px-2 py-2.5 sticky top-0" title={col.label}>
                      {col.label}
                    </th>
                  ))}
                  <th className="text-center font-medium px-2 py-2.5 sticky top-0">Ready</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {filteredRows.map(row => (
                  <tr key={row.companyId} className="hover:bg-zinc-900/40">
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => void openClientWorkbench(row.companyId)}
                        disabled={switching !== null}
                        className="text-zinc-100 hover:text-teal-300 font-medium text-left disabled:opacity-50 disabled:cursor-wait"
                      >
                        {row.companyName}
                      </button>
                      {switching === row.companyId && (
                        <span className="ml-2 text-xs text-zinc-500">switching…</span>
                      )}
                      {row.failed && (
                        <span className="ml-2 text-xs text-rose-400">{row.failedReason}</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      {row.failed ? (
                        <span className="text-zinc-700">—</span>
                      ) : row.trialBalanceBalanced ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 inline" aria-label="TB balanced" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-red-400 inline" aria-label="TB out of balance" />
                      )}
                    </td>
                    {COLUMN_DEFS.map(col => (
                      <StatusCell key={col.id} row={row} columnId={col.id} />
                    ))}
                    <td className="px-2 py-2.5 text-center text-zinc-300 tabular-nums">
                      <span className={row.readyCount === 8 ? 'text-emerald-300' : ''}>
                        {row.readyCount}/8
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && !loading && (
          <p className="mt-4 text-xs text-zinc-600 text-right">
            Generated {new Date(data.generatedAt).toLocaleString('en-ZA')}
          </p>
        )}
      </div>
    </AppLayout>
  );
}
