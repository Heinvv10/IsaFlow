/**
 * Payroll Runs List Page
 * Displays all payroll runs with status, totals, and action links.
 * Route: /payroll/runs
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { CalendarDays, Loader2, AlertCircle, Plus } from 'lucide-react';
import Link from 'next/link';

interface PayrollRunItem {
  id: string;
  period_start: string;
  period_end: string;
  run_date: string;
  status: string;
  total_gross: number;
  total_net: number;
  total_paye: number;
  total_company_cost: number;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    processing: 'bg-blue-500/10 text-blue-400',
    completed: 'bg-teal-500/10 text-teal-400',
    reversed: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/10 text-gray-400'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function formatCurrency(amount: number): string {
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PayrollRunsPage() {
  const [runs, setRuns] = useState<PayrollRunItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadRuns = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/payroll/payroll-runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRuns((json.data ?? json) as PayrollRunItem[]);
    } catch {
      setError('Failed to load payroll runs');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Runs</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Process and manage payroll</p>
              </div>
            </div>
            <Link
              href="/payroll/runs/new"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Payroll Run
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
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-16">
              <CalendarDays className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No payroll runs yet</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Create your first payroll run</p>
              <Link
                href="/payroll/runs/new"
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
              >
                <Plus className="h-4 w-4" />
                New Payroll Run
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Period</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Run Date</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Total Gross</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Total PAYE</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Total Net</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Company Cost</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr
                      key={run.id}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] transition-colors"
                    >
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">
                        {formatDate(run.period_start)} - {formatDate(run.period_end)}
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{formatDate(run.run_date)}</td>
                      <td className="py-3 px-4"><StatusBadge status={run.status} /></td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(run.total_gross)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(run.total_paye)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(run.total_net)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(run.total_company_cost)}</td>
                      <td className="py-3 px-4">
                        <Link
                          href={`/payroll/runs/${run.id}`}
                          className="text-teal-400 hover:text-teal-300 text-xs font-medium transition-colors"
                        >
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
