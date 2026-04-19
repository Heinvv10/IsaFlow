/**
 * Revenue Pipeline Report
 * Route: /accounting/practice/reports/revenue-pipeline
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, Layers } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { PipelineSummary } from '@/modules/accounting/services/practice/practiceReportsService';

function todayIso() { return new Date().toISOString().slice(0, 10); }

const INPUT = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/40';

function ErrBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />{msg}
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: string;
  colour: 'blue' | 'green' | 'amber';
  footnote?: string;
}

function StatCard({ title, value, colour, footnote }: StatCardProps) {
  const ring = colour === 'blue' ? 'border-blue-500/30 bg-blue-500/10' : colour === 'green' ? 'border-green-500/30 bg-green-500/10' : 'border-amber-500/30 bg-amber-500/10';
  const text = colour === 'blue' ? 'text-blue-400' : colour === 'green' ? 'text-green-400' : 'text-amber-400';
  return (
    <div className={`flex-1 min-w-[220px] rounded-xl border p-6 ${ring}`}>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--ff-text-secondary)] mb-3">{title}</p>
      <p className={`text-3xl font-bold tabular-nums ${text}`}>{value}</p>
      {footnote && <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">{footnote}</p>}
    </div>
  );
}

export default function RevenuePipelinePage() {
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState(todayIso());

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/api/accounting/practice/reports/revenue-pipeline?asOfDate=${asOfDate}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: PipelineSummary } | PipelineSummary;
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: PipelineSummary }).data : json) as PipelineSummary;
        setSummary(data);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [asOfDate]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10"><Layers className="h-5 w-5 text-blue-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Revenue Pipeline</h1>
          </div>
        </div>

        <div className="px-6 py-5 max-w-5xl space-y-6">
          {/* filter */}
          <div className="flex flex-wrap gap-4 items-end p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">As of date</label>
              <input type="date" className={INPUT} value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)} />
            </div>
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : summary && (
              <div className="flex flex-wrap gap-4">
                <StatCard
                  title="Approved & unbilled"
                  value={`R${summary.totalApproved.toFixed(2)}`}
                  colour="blue"
                />
                <StatCard
                  title="Invoiced last 30 days"
                  value={`R${summary.totalInvoicedLast30d.toFixed(2)}`}
                  colour="green"
                />
                <StatCard
                  title="Forecast (next 30 days)"
                  value={`R${summary.forecast30d.toFixed(2)}`}
                  colour="amber"
                  footnote="80% of approved WIP"
                />
              </div>
            )
          }
        </div>
      </div>
    </AppLayout>
  );
}
