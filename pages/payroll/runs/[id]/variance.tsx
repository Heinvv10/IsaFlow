/**
 * Payroll Run Variance — VIP-style "Variance" report.
 * Shows per-employee + total deltas vs the prior posted run, with severity flags.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import {
  ArrowLeft, Loader2, AlertCircle, GitCompare, AlertTriangle,
  TrendingUp, TrendingDown, UserPlus, UserMinus,
} from 'lucide-react';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

type Severity = 'new' | 'removed' | 'high' | 'medium' | 'low';

interface VarianceTotals {
  current: number;
  prior: number;
  diff: number;
  pct: number | null;
}

interface EmployeeVariance {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  status: 'unchanged' | 'new' | 'removed' | 'changed';
  severity: Severity;
  grossPay: VarianceTotals;
  paye: VarianceTotals;
  netPay: VarianceTotals;
}

interface PayrollVariance {
  runId: string;
  priorRunId: string | null;
  currentPeriod: { month: number; year: number };
  priorPeriod: { month: number; year: number } | null;
  totals: {
    grossPay: VarianceTotals;
    paye: VarianceTotals;
    uif: VarianceTotals;
    sdl: VarianceTotals;
    netPay: VarianceTotals;
    employeeCount: VarianceTotals;
  };
  employees: EmployeeVariance[];
}

const SEVERITY_BADGE: Record<Severity, { bg: string; fg: string; label: string }> = {
  high:    { bg: 'bg-red-500/10',     fg: 'text-red-400',     label: '≥20%' },
  medium:  { bg: 'bg-amber-500/10',   fg: 'text-amber-400',   label: '≥5%' },
  low:     { bg: 'bg-gray-500/10',    fg: 'text-gray-400',    label: 'OK' },
  new:     { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', label: 'New' },
  removed: { bg: 'bg-purple-500/10',  fg: 'text-purple-400',  label: 'Removed' },
};

function fmtPct(pct: number | null, status?: string): string {
  if (status === 'new') return 'new';
  if (status === 'removed') return 'removed';
  if (pct === null) return '—';
  const v = (pct * 100);
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function DiffCell({ totals, status }: { totals: VarianceTotals; status?: string }) {
  const diff = totals.diff;
  const isUp = diff > 0;
  const isDown = diff < 0;
  return (
    <div className="text-right">
      <div className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(totals.current)}</div>
      <div className={`text-xs font-mono ${isUp ? 'text-amber-400' : isDown ? 'text-emerald-400' : 'text-[var(--ff-text-tertiary)]'}`}>
        {diff === 0 && status !== 'new' && status !== 'removed' ? '—' : (
          <>
            {diff > 0 ? '+' : ''}{formatCurrency(diff)}
            <span className="ml-1 opacity-80">({fmtPct(totals.pct, status)})</span>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, totals }: { label: string; totals: VarianceTotals }) {
  const isUp = totals.diff > 0;
  const Icon = isUp ? TrendingUp : TrendingDown;
  const color = totals.diff === 0
    ? 'text-[var(--ff-text-tertiary)]'
    : isUp ? 'text-amber-400' : 'text-emerald-400';
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">{label}</div>
      <div className="text-xl font-mono text-[var(--ff-text-primary)]">{formatCurrency(totals.current)}</div>
      <div className={`text-xs font-mono mt-1 flex items-center gap-1 ${color}`}>
        {totals.diff !== 0 && <Icon className="h-3 w-3" />}
        {totals.diff > 0 ? '+' : ''}{formatCurrency(totals.diff)} <span className="opacity-80">({fmtPct(totals.pct)})</span>
      </div>
      <div className="text-xs text-[var(--ff-text-tertiary)] mt-1">
        prior {formatCurrency(totals.prior)}
      </div>
    </div>
  );
}

export default function PayrollRunVariancePage() {
  const router = useRouter();
  const { id } = router.query;
  const runId = typeof id === 'string' ? id : '';

  const [data, setData] = useState<PayrollVariance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showOnly, setShowOnly] = useState<'all' | 'flagged'>('flagged');

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/variance`);
      const json = await res.json() as { data?: PayrollVariance; message?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message || json.message || `HTTP ${res.status}`);
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    if (showOnly === 'all') return data.employees;
    return data.employees.filter((e) => ['high', 'new', 'removed'].includes(e.severity));
  }, [data, showOnly]);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
      </AppLayout>
    );
  }
  if (error || !data) {
    return (
      <AppLayout>
        <div className="p-6">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error ?? 'No data'}
          </div>
        </div>
      </AppLayout>
    );
  }

  const curLabel = `${MONTHS[data.currentPeriod.month - 1]} ${data.currentPeriod.year}`;
  const priorLabel = data.priorPeriod ? `${MONTHS[data.priorPeriod.month - 1]} ${data.priorPeriod.year}` : 'no prior run';
  const flaggedCount = data.employees.filter((e) => ['high', 'new', 'removed'].includes(e.severity)).length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href={`/payroll/runs/${runId}`} className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-amber-500/10">
              <GitCompare className="h-6 w-6 text-amber-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Variance — {curLabel} vs {priorLabel}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Per-employee deltas. Flagged when ≥20% change, new hires, or removals.
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {!data.priorRunId && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
              <AlertTriangle className="h-4 w-4" /> No prior payroll run — every line shows as &quot;new&quot;.
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard label="Gross"     totals={data.totals.grossPay} />
            <SummaryCard label="PAYE"      totals={data.totals.paye} />
            <SummaryCard label="UIF"       totals={data.totals.uif} />
            <SummaryCard label="SDL"       totals={data.totals.sdl} />
            <SummaryCard label="Net Pay"   totals={data.totals.netPay} />
            <SummaryCard label="Employees" totals={data.totals.employeeCount} />
          </div>

          {/* Filter toggle */}
          <div className="flex items-center justify-between">
            <div className="inline-flex rounded-lg border border-[var(--ff-border-primary)] overflow-hidden">
              <button onClick={() => setShowOnly('flagged')}
                className={`px-3 py-1.5 text-xs ${showOnly === 'flagged' ? 'bg-amber-500/10 text-amber-400' : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]'}`}>
                Flagged only ({flaggedCount})
              </button>
              <button onClick={() => setShowOnly('all')}
                className={`px-3 py-1.5 text-xs border-l border-[var(--ff-border-primary)] ${showOnly === 'all' ? 'bg-teal-500/10 text-teal-400' : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]'}`}>
                All ({data.employees.length})
              </button>
            </div>
          </div>

          {/* Per-employee table */}
          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            {visible.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-[var(--ff-text-tertiary)]">
                {showOnly === 'flagged' ? 'No flagged employees — every change is below 20%.' : 'No employee lines.'}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employee</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Gross (Δ)</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">PAYE (Δ)</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Net (Δ)</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e) => {
                    const badge = SEVERITY_BADGE[e.severity];
                    const StatusIcon = e.status === 'new' ? UserPlus : e.status === 'removed' ? UserMinus : null;
                    return (
                      <tr key={e.employeeId} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                        <td className="py-3 px-4">
                          <div className="text-[var(--ff-text-primary)]">{e.employeeName}</div>
                          <div className="text-xs font-mono text-[var(--ff-text-tertiary)]">{e.employeeNumber}</div>
                        </td>
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
                            {StatusIcon && <StatusIcon className="h-3 w-3" />} {badge.label}
                          </span>
                        </td>
                        <td className="py-3 px-4"><DiffCell totals={e.grossPay} status={e.status} /></td>
                        <td className="py-3 px-4"><DiffCell totals={e.paye} status={e.status} /></td>
                        <td className="py-3 px-4"><DiffCell totals={e.netPay} status={e.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
