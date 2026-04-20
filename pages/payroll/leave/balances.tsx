/**
 * Leave Balances grid — one row per employee, columns per leave type.
 * Route: /payroll/leave/balances
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { BarChart3, Loader2, AlertCircle, ArrowLeft, Play, RotateCcw, CheckCircle2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface BalanceRow {
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  accrued: number;
  taken: number;
  pending: number;
  balance: number;
}

interface EmployeeBalances {
  employeeId: string;
  employeeName: string;
  balances: Record<string, { accrued: number; taken: number; pending: number; balance: number }>;
}

function BalanceCell({ accrued, balance }: { accrued: number; balance: number }) {
  const pct = accrued > 0 ? balance / accrued : 1;
  const color =
    pct >= 0.5
      ? 'text-teal-400'
      : pct >= 0.25
        ? 'text-yellow-400'
        : 'text-red-400';
  return (
    <td className={`py-3 px-4 text-right text-sm font-medium ${color}`}>
      {balance.toFixed(1)}
      <span className="ml-1 text-xs text-[var(--ff-text-tertiary)]">/ {accrued.toFixed(1)}</span>
    </td>
  );
}

export default function LeaveBalancesPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [leaveTypes, setLeaveTypes] = useState<string[]>([]);
  const [employees, setEmployees] = useState<EmployeeBalances[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [actionBusy, setActionBusy] = useState<'accrue' | 'rollover' | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/leave/balances?year=${year}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: BalanceRow[] };
      const rows = (json.data ?? []) as BalanceRow[];

      // Pivot: collect unique leave types
      const typeSet = new Set<string>();
      rows.forEach(r => typeSet.add(r.leaveTypeName));
      const types = Array.from(typeSet).sort();
      setLeaveTypes(types);

      // Group by employee
      const empMap = new Map<string, EmployeeBalances>();
      rows.forEach(r => {
        if (!empMap.has(r.employeeId)) {
          empMap.set(r.employeeId, { employeeId: r.employeeId, employeeName: r.employeeName, balances: {} });
        }
        const emp = empMap.get(r.employeeId)!;
        emp.balances[r.leaveTypeName] = {
          accrued: r.accrued,
          taken: r.taken,
          pending: r.pending,
          balance: r.balance,
        };
      });
      setEmployees(Array.from(empMap.values()));
    } catch {
      setError('Failed to load balances');
    } finally {
      setIsLoading(false);
    }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const currentYear = new Date().getFullYear();
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];

  const runAccrual = async () => {
    setActionError(null);
    setActionResult(null);
    setActionBusy('accrue');
    try {
      const now = new Date();
      const monthForYear = year === now.getFullYear() ? now.getMonth() + 1 : 12;
      const res = await apiFetch(`/api/payroll/leave/accrue?year=${year}&month=${monthForYear}`, { method: 'POST' });
      const json = await res.json() as { data?: { updated: number; skipped: number }; error?: { message?: string } };
      if (!res.ok) {
        setActionError(json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const r = json.data ?? { updated: 0, skipped: 0 };
      setActionResult(`Accrual to end of ${monthForYear}/${year}: ${r.updated} updated, ${r.skipped} skipped`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Accrual failed');
    } finally {
      setActionBusy(null);
    }
  };

  const runRollover = async () => {
    const fromYear = year - 1;
    const toYear = year;
    if (!window.confirm(`Roll leave balances from ${fromYear} into ${toYear}? Carry-over caps per leave type will be applied.`)) return;
    setActionError(null);
    setActionResult(null);
    setActionBusy('rollover');
    try {
      const res = await apiFetch(`/api/payroll/leave/rollover?fromYear=${fromYear}&toYear=${toYear}`, { method: 'POST' });
      const json = await res.json() as { data?: { updated: number; skipped: number }; error?: { message?: string } };
      if (!res.ok) {
        setActionError(json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const r = json.data ?? { updated: 0, skipped: 0 };
      setActionResult(`Rolled ${fromYear} → ${toYear}: ${r.updated} updated, ${r.skipped} skipped (already had activity)`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rollover failed');
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-4">
            <Link href="/payroll/leave" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <BarChart3 className="h-5 w-5 text-teal-500" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Leave Balances</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Remaining leave per employee</p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => void runAccrual()}
                disabled={actionBusy !== null}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm font-medium disabled:opacity-50"
                title="Apply BCEA accrual up to the current month"
              >
                {actionBusy === 'accrue' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run Monthly Accrual
              </button>
              <button
                type="button"
                onClick={() => void runRollover()}
                disabled={actionBusy !== null}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm font-medium disabled:opacity-50"
                title={`Carry balances from ${year - 1} into ${year}`}
              >
                {actionBusy === 'rollover' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Roll Over Year
              </button>
              <select
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="p-6 overflow-x-auto">
          {actionResult && (
            <div className="mb-4 rounded-lg border border-teal-500/30 bg-teal-500/5 text-sm text-teal-300 px-3 py-2 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{actionResult}</span>
            </div>
          )}
          {actionError && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 text-sm text-red-300 px-3 py-2 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /> <span>{error}</span>
            </div>
          ) : employees.length === 0 ? (
            <div className="text-center py-16 text-[var(--ff-text-secondary)]">
              No leave balance data for {year}. Balances are created when employees accrue leave.
            </div>
          ) : (
            <>
              <p className="text-xs text-[var(--ff-text-tertiary)] mb-3">
                Colour: <span className="text-teal-400">green</span> ≥ 50% · <span className="text-yellow-400">amber</span> 25–49% · <span className="text-red-400">red</span> &lt; 25% of accrued remaining
              </p>
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employee</th>
                      {leaveTypes.map(t => (
                        <th key={t} className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium whitespace-nowrap">{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map(emp => (
                      <tr key={emp.employeeId} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                        <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">{emp.employeeName}</td>
                        {leaveTypes.map(t => {
                          const b = emp.balances[t];
                          if (!b) return <td key={t} className="py-3 px-4 text-right text-[var(--ff-text-tertiary)] text-sm">—</td>;
                          return <BalanceCell key={t} accrued={b.accrued} balance={b.balance} />;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
