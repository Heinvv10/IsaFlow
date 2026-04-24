/**
 * Cost centre summary for a payroll run.
 * Route: /payroll/runs/[id]/cost-centre-summary
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { Building2, Loader2, AlertCircle, ArrowLeft } from 'lucide-react';

interface SummaryRow {
  costCentreId: string | null;
  costCentreCode: string | null;
  costCentreName: string | null;
  employeeCount: number;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
}
interface Summary {
  runId: string;
  rows: SummaryRow[];
  totals: Omit<SummaryRow, 'costCentreId' | 'costCentreCode' | 'costCentreName'>;
}

export default function CostCentreSummaryPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${id}/cost-centre-summary`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((json.data ?? json) as Summary);
    } catch {
      setError('Failed to load cost centre summary');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center gap-3">
          <Link href={`/payroll/runs/${id}`} className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
            <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
          </Link>
          <div className="p-2 rounded-lg bg-sky-500/10"><Building2 className="h-6 w-6 text-sky-500" /></div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Cost Centre Summary</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Per-centre breakdown of this payroll run</p>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-sky-500" /></div>
          ) : error || !data ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12"><AlertCircle className="h-5 w-5" /><span>{error || 'No data'}</span></div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Code</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Name</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Employees</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Gross</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">PAYE</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">UIF</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">SDL</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">ETI</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, idx) => (
                    <tr key={idx} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-2 px-3 font-mono">{r.costCentreCode ?? <span className="italic text-[var(--ff-text-tertiary)]">Unassigned</span>}</td>
                      <td className="py-2 px-3">{r.costCentreName ?? '—'}</td>
                      <td className="py-2 px-3 text-right font-mono">{r.employeeCount}</td>
                      <td className="py-2 px-3 text-right font-mono">{formatCurrency(r.totalGross)}</td>
                      <td className="py-2 px-3 text-right font-mono">{formatCurrency(r.totalPaye)}</td>
                      <td className="py-2 px-3 text-right font-mono">{formatCurrency(r.totalUif)}</td>
                      <td className="py-2 px-3 text-right font-mono">{formatCurrency(r.totalSdl)}</td>
                      <td className="py-2 px-3 text-right font-mono">{formatCurrency(r.totalEti)}</td>
                      <td className="py-2 px-3 text-right font-mono font-medium">{formatCurrency(r.totalNet)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[var(--ff-bg-secondary)] border-t border-[var(--ff-border-primary)] font-medium">
                    <td className="py-2 px-3" colSpan={2}>Totals</td>
                    <td className="py-2 px-3 text-right font-mono">{data.totals.employeeCount}</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(data.totals.totalGross)}</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(data.totals.totalPaye)}</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(data.totals.totalUif)}</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(data.totals.totalSdl)}</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(data.totals.totalEti)}</td>
                    <td className="py-2 px-3 text-right font-mono">{formatCurrency(data.totals.totalNet)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
