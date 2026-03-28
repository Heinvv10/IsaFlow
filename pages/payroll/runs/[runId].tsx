/**
 * Payroll Run Detail Page
 * View run summary, payslips, complete/reverse, download payslips.
 * Route: /payroll/runs/[runId]
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  CalendarDays, Loader2, AlertCircle, ArrowLeft,
  CheckCircle, RotateCcw, FileText, Download,
} from 'lucide-react';
import Link from 'next/link';
import { notify } from '@/utils/toast';

interface Payslip {
  id: string;
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  department?: string;
  basic_salary: number;
  travel_allowance: number;
  housing_allowance: number;
  cell_allowance: number;
  other_allowances: number;
  gross_pay: number;
  paye: number;
  uif_employee: number;
  uif_employer: number;
  sdl: number;
  medical_aid: number;
  retirement_fund: number;
  other_deductions: number;
  total_deductions: number;
  net_pay: number;
  ytd_gross: number;
  ytd_paye: number;
}

interface PayrollRunDetail {
  id: string;
  period_start: string;
  period_end: string;
  run_date: string;
  status: string;
  total_gross: number;
  total_paye: number;
  total_uif_employee: number;
  total_uif_employer: number;
  total_sdl: number;
  total_net: number;
  total_company_cost: number;
  journal_entry_id: string | null;
  payslips: Payslip[];
}

function formatCurrency(amount: number): string {
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
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

export default function PayrollRunDetailPage() {
  const router = useRouter();
  const { runId } = router.query;

  const [run, setRun] = useState<PayrollRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isActioning, setIsActioning] = useState(false);

  const loadRun = useCallback(async () => {
    if (!runId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/payroll/payroll-runs-detail?id=${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRun((json.data ?? json) as PayrollRunDetail);
    } catch {
      setError('Failed to load payroll run');
    } finally {
      setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    loadRun();
  }, [loadRun]);

  async function handleAction(action: 'complete' | 'reverse') {
    if (!run) return;
    const label = action === 'complete' ? 'complete and post to GL' : 'reverse';
    if (!confirm(`Are you sure you want to ${label} this payroll run?`)) return;

    setIsActioning(true);
    try {
      const res = await fetch('/api/payroll/payroll-runs-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? json.message ?? `HTTP ${res.status}`);

      notify.success(action === 'complete' ? 'Payroll completed and posted to GL' : 'Payroll run reversed');
      loadRun();
    } catch (err: unknown) {
      notify.error(err instanceof Error ? err.message : `Failed to ${action} payroll run`);
    } finally {
      setIsActioning(false);
    }
  }

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error || !run) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center gap-2 text-red-400 py-12">
          <AlertCircle className="h-5 w-5" />
          <span>{error || 'Payroll run not found'}</span>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/payroll/runs"
                className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                  Payroll Run: {formatDate(run.period_start)} - {formatDate(run.period_end)}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)] flex items-center gap-2">
                  Run date: {formatDate(run.run_date)}
                  <StatusBadge status={run.status} />
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {run.status === 'draft' && (
                <button
                  onClick={() => handleAction('complete')}
                  disabled={isActioning}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                >
                  {isActioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                  Complete & Post to GL
                </button>
              )}
              {run.status === 'completed' && (
                <button
                  onClick={() => handleAction('reverse')}
                  disabled={isActioning}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                >
                  {isActioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  Reverse
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="p-6">
          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <StatCard label="Total Gross" value={formatCurrency(run.total_gross)} />
            <StatCard label="Total PAYE" value={formatCurrency(run.total_paye)} />
            <StatCard label="Total Net Pay" value={formatCurrency(run.total_net)} highlight />
            <StatCard label="Company Cost" value={formatCurrency(run.total_company_cost)} />
            <StatCard label="UIF (Employee)" value={formatCurrency(run.total_uif_employee)} />
            <StatCard label="UIF (Employer)" value={formatCurrency(run.total_uif_employer)} />
            <StatCard label="SDL" value={formatCurrency(run.total_sdl)} />
            <StatCard label="Employees" value={String(run.payslips.length)} />
          </div>

          {run.journal_entry_id && (
            <div className="mb-6 p-3 rounded-lg bg-teal-500/5 border border-teal-500/20 text-sm text-teal-400">
              GL Journal Entry posted: {run.journal_entry_id}
            </div>
          )}

          {/* Payslips Table */}
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
              Payslips ({run.payslips.length})
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  // Download all payslips by opening each in new tab
                  for (const slip of run.payslips) {
                    window.open(`/api/payroll/payslip-pdf?id=${slip.id}`, '_blank');
                  }
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-xs font-medium transition-colors"
              >
                <Download className="h-3 w-3" />
                Download All Payslips
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium whitespace-nowrap">Employee</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Basic</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Allowances</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Gross</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">PAYE</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Medical</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Retirement</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Net Pay</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {run.payslips.map((slip) => {
                    const totalAllowances = slip.travel_allowance + slip.housing_allowance +
                      slip.cell_allowance + slip.other_allowances;
                    return (
                      <tr key={slip.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                        <td className="py-2 px-4">
                          <div className="text-[var(--ff-text-primary)]">{slip.first_name} {slip.last_name}</div>
                          <div className="text-xs text-[var(--ff-text-tertiary)]">{slip.employee_number} | {slip.department || '-'}</div>
                        </td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.basic_salary)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(totalAllowances)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(slip.gross_pay)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.paye)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.uif_employee)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.medical_aid)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.retirement_fund)}</td>
                        <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(slip.net_pay)}</td>
                        <td className="py-2 px-4">
                          <a
                            href={`/api/payroll/payslip-pdf?id=${slip.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300 text-xs font-medium transition-colors"
                          >
                            <FileText className="h-3 w-3" />
                            PDF
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`p-4 rounded-lg border ${
      highlight
        ? 'border-teal-500/30 bg-teal-500/5'
        : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]'
    }`}>
      <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{label}</p>
      <p className={`text-lg font-semibold font-mono ${
        highlight ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'
      }`}>{value}</p>
    </div>
  );
}
