/**
 * IRP5 Readiness Dashboard
 * Shows per-employee blocking issues + warnings + company roll-up.
 */

import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface EmployeeReadiness {
  id: string;
  employee_number: string;
  name: string;
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

interface CompanyReadiness {
  taxYear: number;
  totalEmployees: number;
  readyCount: number;
  blockingCount: number;
  warningCount: number;
  employees: EmployeeReadiness[];
}

export default function IRP5ReadinessPage() {
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<CompanyReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/payroll/irp5-readiness?taxYear=${taxYear}`);
        const json = await res.json();
        if (!cancelled) {
          if (json.success) setData(json.data as CompanyReadiness);
          else setError(json.error?.message || 'Failed to load readiness');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [taxYear]);

  const readyPct = data && data.totalEmployees > 0
    ? Math.round((data.readyCount / data.totalEmployees) * 100)
    : 0;

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">IRP5 Readiness</h1>
            <p className="text-sm text-gray-500 dark:text-slate-400">Submission-readiness for the tax year</p>
          </div>
          <select
            className="rounded-md border-gray-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 text-sm"
            value={taxYear}
            onChange={(e) => setTaxYear(Number(e.target.value))}
          >
            {[2024, 2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>{`Tax year ${y} (Mar ${y - 1} – Feb ${y})`}</option>
            ))}
          </select>
        </div>

        {loading && <div className="text-gray-500 dark:text-slate-400">Loading…</div>}
        {error && <div className="text-red-600 dark:text-red-400">{error}</div>}

        {data && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Total employees" value={data.totalEmployees} />
              <StatCard label="Ready to submit" value={data.readyCount} valueClass="text-green-600 dark:text-emerald-400" />
              <StatCard label="With blockers" value={data.blockingCount} valueClass="text-red-600 dark:text-red-400" />
              <StatCard label="With warnings" value={data.warningCount} valueClass="text-amber-600 dark:text-amber-400" />
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow p-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Submission readiness</span>
                <span className="text-sm font-mono text-gray-700 dark:text-slate-300">{data.readyCount}/{data.totalEmployees} ({readyPct}%)</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-slate-800 rounded-full h-3">
                <div
                  className="bg-green-600 dark:bg-emerald-500 h-3 rounded-full transition-all"
                  style={{ width: `${readyPct}%` }}
                />
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800">
                <thead className="bg-gray-50 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-400 uppercase">Employee</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-400 uppercase">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-slate-400 uppercase">Issues</th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-slate-900 divide-y divide-gray-200 dark:divide-slate-800">
                  {data.employees.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 text-sm">
                        <div className="font-medium text-gray-900 dark:text-slate-100">{e.name}</div>
                        <div className="text-gray-500 dark:text-slate-400 text-xs">{e.employee_number}</div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {e.ready
                          ? <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 dark:bg-emerald-500/15 text-green-800 dark:text-emerald-300">Ready</span>
                          : <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 dark:bg-red-500/15 text-red-800 dark:text-red-300">Blocked</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-sm space-y-1">
                        {e.blocking.map((b, i) => (
                          <div key={`b-${i}`} className="text-red-600 dark:text-red-400">● {b}</div>
                        ))}
                        {e.warnings.map((w, i) => (
                          <div key={`w-${i}`} className="text-amber-600 dark:text-amber-400">⚠ {w}</div>
                        ))}
                        {e.blocking.length === 0 && e.warnings.length === 0 && (
                          <span className="text-gray-600 dark:text-gray-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}

function StatCard({ label, value, valueClass = 'text-gray-900 dark:text-slate-100' }: {
  label: string; value: number; valueClass?: string;
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow p-4">
      <div className="text-xs text-gray-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}
