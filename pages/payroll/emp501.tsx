/**
 * EMP501 Reconciliation
 * Compares sum of monthly EMP201 totals against aggregate IRP5 totals.
 */

import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface MonthlyTotal {
  month: string;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
}

interface Emp501 {
  taxYear: number;
  monthly: MonthlyTotal[];
  emp201Totals: { paye: number; uifEmployee: number; uifEmployer: number; sdl: number; eti: number };
  irp5Totals: { paye: number; uifEmployee: number; uifEmployer: number };
  differences: { paye: number; uifEmployee: number; uifEmployer: number };
  isReconciled: boolean;
}

function R(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Emp501Page() {
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<Emp501 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/payroll/emp501-reconciliation?taxYear=${taxYear}`);
        const json = await res.json();
        if (!cancelled) {
          if (json.success) setData(json.data as Emp501);
          else setError(json.error?.message || 'Failed to load reconciliation');
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

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">EMP501 Reconciliation</h1>
            <p className="text-sm text-gray-500">Annual PAYE/UIF vs sum of monthly EMP201s</p>
          </div>
          <select
            className="rounded-md border-gray-300 text-sm"
            value={taxYear}
            onChange={(e) => setTaxYear(Number(e.target.value))}
          >
            {[2024, 2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>{`Tax year ${y}`}</option>
            ))}
          </select>
        </div>

        {loading && <div className="text-gray-500">Loading…</div>}
        {error && <div className="text-red-600">{error}</div>}

        {data && (
          <>
            <div className={`rounded-lg p-4 ${data.isReconciled ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className="font-semibold">
                {data.isReconciled
                  ? '✔ Reconciled — EMP201 totals match IRP5 totals'
                  : '✘ Not reconciled — differences detected'}
              </div>
              {!data.isReconciled && (
                <div className="mt-2 text-sm text-red-800 space-y-1">
                  {data.differences.paye !== 0 && <div>PAYE difference: {R(data.differences.paye)}</div>}
                  {data.differences.uifEmployee !== 0 && <div>UIF employee difference: {R(data.differences.uifEmployee)}</div>}
                  {data.differences.uifEmployer !== 0 && <div>UIF employer difference: {R(data.differences.uifEmployer)}</div>}
                </div>
              )}
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Month</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">PAYE</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">UIF (emp)</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">UIF (er)</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">SDL</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">ETI</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.monthly.map((m) => (
                    <tr key={m.month}>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{m.month}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.paye)}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.uifEmployee)}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.uifEmployer)}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.sdl)}</td>
                      <td className="px-4 py-3 text-sm text-right text-green-700">{R(m.eti)}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-3 text-sm">EMP201 total</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.paye)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.uifEmployee)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.uifEmployer)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.sdl)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.eti)}</td>
                  </tr>
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-3 text-sm">IRP5 aggregate</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.irp5Totals.paye)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.irp5Totals.uifEmployee)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.irp5Totals.uifEmployer)}</td>
                    <td className="px-4 py-3 text-sm text-right">—</td>
                    <td className="px-4 py-3 text-sm text-right">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
