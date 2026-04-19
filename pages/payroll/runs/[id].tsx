/**
 * Payroll Run Detail — Phase 2.
 * Route: /payroll/runs/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { CalendarDays, ArrowLeft, Loader2, AlertCircle, Calculator, CheckCircle2 } from 'lucide-react';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

interface Line {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
}

interface RunDetail {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
  lines: Line[];
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    calculated: 'bg-blue-500/10 text-blue-400',
    approved: 'bg-teal-500/10 text-teal-400',
    posted: 'bg-emerald-500/10 text-emerald-400',
    cancelled: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-500/10 text-gray-400'}`}>
      {status}
    </span>
  );
}

export default function PayrollRunDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const runId = typeof id === 'string' ? id : '';

  const [run, setRun] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRun((json.data ?? json) as RunDetail);
    } catch {
      setError('Failed to load run');
    } finally {
      setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  const calculate = async () => {
    if (!runId) return;
    setCalculating(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/calculate`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calculate failed');
    } finally {
      setCalculating(false);
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)]">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }
  if (error && !run) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)] flex-col gap-2">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
          <Link href="/payroll/runs" className="text-teal-400 text-sm">Back</Link>
        </div>
      </AppLayout>
    );
  }
  if (!run) return null;

  const period = `${MONTHS[run.periodMonth - 1]} ${run.periodYear}`;
  const canCalculate = run.status === 'draft' || run.status === 'calculated';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Run — {period}</h1>
                <div className="flex items-center gap-2 mt-1"><StatusBadge status={run.status} /></div>
              </div>
            </div>
            <button onClick={calculate} disabled={calculating || !canCalculate}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
              {calculating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
              {run.status === 'draft' ? 'Calculate' : 'Recalculate'}
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}

          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { label: 'Employees', value: String(run.employeeCount), mono: false, accent: false },
              { label: 'Total Gross', value: formatCurrency(run.totalGross), mono: true, accent: false },
              { label: 'Total PAYE', value: formatCurrency(run.totalPaye), mono: true, accent: false },
              { label: 'Total UIF', value: formatCurrency(run.totalUif), mono: true, accent: false },
              { label: 'Total SDL', value: formatCurrency(run.totalSdl), mono: true, accent: false },
              { label: 'Total Net', value: formatCurrency(run.totalNet), mono: true, accent: true },
            ].map(stat => (
              <div key={stat.label} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[var(--ff-text-tertiary)]">{stat.label}</p>
                <p className={`mt-1 ${stat.mono ? 'font-mono' : ''} ${stat.accent ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'} text-sm font-semibold`}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line items</h2>
              {run.status === 'calculated' && (
                <span className="flex items-center gap-1 text-xs text-teal-400">
                  <CheckCircle2 className="h-4 w-4" /> Calculated
                </span>
              )}
            </div>
            {run.lines.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)] text-sm">
                No lines yet — press <span className="text-teal-400 font-medium">Calculate</span> to generate payroll for this period.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Gross</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">PAYE</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">UIF (E)</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">UIF (R)</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">SDL</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">ETI</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {run.lines.map(l => (
                    <tr key={l.id} className="border-t border-[var(--ff-border-primary)]">
                      <td className="py-2 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{l.employeeNumber}</td>
                      <td className="py-2 px-4 text-[var(--ff-text-primary)]">{l.employeeName}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(l.grossPay)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.paye)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.uifEmployee)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.uifEmployer)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.sdl)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.eti)}</td>
                      <td className="py-2 px-4 text-right font-mono text-teal-400 font-medium">{formatCurrency(l.netPay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </AppLayout>
  );
}
