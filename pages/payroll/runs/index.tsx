/**
 * Payroll Runs List — Phase 2.
 * Route: /payroll/runs
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { CalendarDays, Loader2, AlertCircle, Plus } from 'lucide-react';

interface RunRow {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalNet: number;
  employeeCount: number;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const periodLabel = (r: RunRow) => `${MONTHS[r.periodMonth - 1]} ${r.periodYear}`;

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

export default function PayrollRunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRuns((json.data ?? json) as RunRow[]);
    } catch {
      setError('Failed to load payroll runs');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Runs</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Monthly payroll cycles</p>
              </div>
            </div>
            <Link href="/payroll/runs/new" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> New Payroll Run
            </Link>
          </div>
        </div>

        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-16">
              <CalendarDays className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No payroll runs yet</p>
              <Link href="/payroll/runs/new" className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
                <Plus className="h-4 w-4" /> New Payroll Run
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Period</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Employees</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Gross</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">PAYE</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Net</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{periodLabel(r)}</td>
                      <td className="py-3 px-4"><StatusBadge status={r.status} /></td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{r.employeeCount}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(r.totalGross)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(r.totalPaye)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(r.totalNet)}</td>
                      <td className="py-3 px-4 text-right">
                        <Link href={`/payroll/runs/${r.id}`} className="text-teal-400 hover:text-teal-300 text-xs font-medium">
                          View
                        </Link>
                      </td>
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
