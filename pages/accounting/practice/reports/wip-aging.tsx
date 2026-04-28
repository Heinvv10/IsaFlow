/**
 * WIP Aging Report
 * Route: /accounting/practice/reports/wip-aging
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, Clock, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { WipAgingRow } from '@/modules/accounting/services/practice/practiceReportsService';

const fmtZAR = (v: number) => formatCurrencyAmount(v, 'ZAR');
import { PeriodPicker } from '@/components/practice/PeriodPicker';
import { downloadCsv, asOfFilename } from '@/lib/csvExport';
import type { CsvColumn } from '@/lib/csvExport';

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';
const TF = 'py-2 px-3 text-sm font-semibold text-[var(--ff-text-primary)]';

function ErrBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />{msg}
    </div>
  );
}

function bucketColour(value: number, bucket: '0-7' | '8-14' | '15-30' | '31+') {
  if (value === 0) return 'text-slate-500';
  if (bucket === '0-7') return 'text-green-400';
  if (bucket === '8-14') return 'text-teal-400';
  if (bucket === '15-30') return 'text-amber-400';
  return 'text-rose-400';
}

export default function WipAgingPage() {
  const [rows, setRows] = useState<WipAgingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState(localISODate());

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/api/accounting/practice/reports/wip-aging?asOfDate=${asOfDate}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: WipAgingRow[] } | WipAgingRow[];
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: WipAgingRow[] }).data : json) as WipAgingRow[];
        setRows(data ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [asOfDate]);

  const totals = rows.reduce(
    (s, r) => ({ b0: s.b0 + r.bucket0to7, b8: s.b8 + r.bucket8to14, b15: s.b15 + r.bucket15to30, b31: s.b31 + r.bucket31plus, total: s.total + r.total }),
    { b0: 0, b8: 0, b15: 0, b31: 0, total: 0 },
  );

  function handleDownload() {
    const columns: CsvColumn<WipAgingRow>[] = [
      { header: 'Client', accessor: (r) => r.legalName },
      { header: '0-7 days', accessor: (r) => r.bucket0to7 },
      { header: '8-14 days', accessor: (r) => r.bucket8to14 },
      { header: '15-30 days', accessor: (r) => r.bucket15to30 },
      { header: '31+ days', accessor: (r) => r.bucket31plus },
      { header: 'Total', accessor: (r) => r.total },
    ];
    downloadCsv(asOfFilename('wip-aging', asOfDate), columns, rows);
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10"><Clock className="h-5 w-5 text-amber-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">WIP Aging</h1>
            <div className="ml-auto">
              <button
                onClick={handleDownload}
                disabled={rows.length === 0 && !loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border bg-white hover:bg-slate-50 text-sm text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="h-3.5 w-3.5" />Download CSV
              </button>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 max-w-7xl space-y-5">
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
            <span className="font-medium">Includes:</span> approved billable time entries that are not yet invoiced. Excludes draft, submitted, written-off, and non-billable entries.
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : (
              <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
                <table className="table-auto w-full">
                  <thead>
                    <tr className="bg-slate-50/5">
                      <th className={TH}>Client</th>
                      <th className={`${TH} text-right`}>0–7 days</th>
                      <th className={`${TH} text-right`}>8–14 days</th>
                      <th className={`${TH} text-right`}>15–30 days</th>
                      <th className={`${TH} text-right`}>31+ days</th>
                      <th className={`${TH} text-right`}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? <tr><td colSpan={6} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">No unbilled approved WIP found.</td></tr>
                      : rows.map((r, i) => (
                        <tr key={r.practiceClientId} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                          <td className={`${TD} font-medium`}>
                            <Link
                              href={`/accounting/practice/clients/${r.practiceClientId}`}
                              className="text-[var(--ff-text-primary)] hover:text-teal-400 transition-colors"
                            >
                              {r.legalName}
                            </Link>
                          </td>
                          <td className={`${TD} text-right tabular-nums ${bucketColour(r.bucket0to7, '0-7')}`}>{fmtZAR(r.bucket0to7)}</td>
                          <td className={`${TD} text-right tabular-nums ${bucketColour(r.bucket8to14, '8-14')}`}>{fmtZAR(r.bucket8to14)}</td>
                          <td className={`${TD} text-right tabular-nums ${bucketColour(r.bucket15to30, '15-30')}`}>{fmtZAR(r.bucket15to30)}</td>
                          <td className={`${TD} text-right tabular-nums ${bucketColour(r.bucket31plus, '31+')}`}>{fmtZAR(r.bucket31plus)}</td>
                          <td className={`${TD} text-right tabular-nums font-semibold text-[var(--ff-text-primary)]`}>{fmtZAR(r.total)}</td>
                        </tr>
                      ))
                    }
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 border-[var(--ff-border-primary)] bg-slate-50/10">
                        <td className={TF}>Totals</td>
                        <td className={`${TF} text-right tabular-nums`}>{fmtZAR(totals.b0)}</td>
                        <td className={`${TF} text-right tabular-nums`}>{fmtZAR(totals.b8)}</td>
                        <td className={`${TF} text-right tabular-nums`}>{fmtZAR(totals.b15)}</td>
                        <td className={`${TF} text-right tabular-nums text-rose-400`}>{fmtZAR(totals.b31)}</td>
                        <td className={`${TF} text-right tabular-nums`}>{fmtZAR(totals.total)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )
          }
        </div>
      </div>
    </AppLayout>
  );
}
