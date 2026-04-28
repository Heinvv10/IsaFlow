/**
 * Revenue Pipeline Report
 * Route: /accounting/practice/reports/revenue-pipeline
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, Layers, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { PipelineSummary } from '@/modules/accounting/services/practice/practiceReportsService';

const fmtZAR = (v: number) => formatCurrencyAmount(v, 'ZAR');
import { PeriodPicker } from '@/components/practice/PeriodPicker';
import { downloadCsv, asOfFilename } from '@/lib/csvExport';
import type { CsvColumn } from '@/lib/csvExport';

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
  const [asOfDate, setAsOfDate] = useState(localISODate());

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

  function handleDownload() {
    const columns: CsvColumn<PipelineSummary>[] = [
      { header: 'As of', accessor: (r) => r.asOfDate },
      { header: 'Approved unbilled (ZAR)', accessor: (r) => r.totalApproved },
      { header: 'Invoiced last 30d (ZAR)', accessor: (r) => r.totalInvoicedLast30d },
      { header: 'Forecast 30d (ZAR)', accessor: (r) => r.forecast30d },
    ];
    downloadCsv(asOfFilename('revenue-pipeline', asOfDate), columns, summary ? [summary] : []);
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10"><Layers className="h-5 w-5 text-blue-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Revenue Pipeline</h1>
            <div className="ml-auto">
              <button
                onClick={handleDownload}
                disabled={summary == null && !loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border bg-white hover:bg-slate-50 text-sm text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="h-3.5 w-3.5" />Download CSV
              </button>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 max-w-5xl space-y-6">
          {/* filter */}
          <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <PeriodPicker
              mode="asof"
              value={{ asOfDate }}
              onChange={(v) => setAsOfDate((v as { asOfDate: string }).asOfDate)}
            />
          </div>

          {/* Inclusion legend — addresses 2026-04-27 audit's "reports don't
              explain what's included" finding. */}
          <div className="text-xs text-[var(--ff-text-tertiary)] px-1">
            <span className="font-medium">Approved &amp; unbilled:</span> billable time approved but not yet on a customer invoice. <span className="font-medium">Invoiced last 30 days:</span> customer invoices in the trailing 30 days. <span className="font-medium">Forecast:</span> 80% of approved unbilled — a conservative collection estimate, not a contracted commitment.
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : summary && (
              <div className="flex flex-wrap gap-4">
                <StatCard title="Approved & unbilled" value={fmtZAR(summary.totalApproved)} colour="blue" />
                <StatCard title="Invoiced last 30 days" value={fmtZAR(summary.totalInvoicedLast30d)} colour="green" />
                <StatCard title="Forecast (next 30 days)" value={fmtZAR(summary.forecast30d)} colour="amber" footnote="80% of approved WIP" />
              </div>
            )
          }
        </div>
      </div>
    </AppLayout>
  );
}
