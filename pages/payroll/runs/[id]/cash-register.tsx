/**
 * Cash Pay Register — ZAR denomination breakdown for cash-paid employees in a run.
 * Route: /payroll/runs/[id]/cash-register
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Banknote, ArrowLeft, Loader2, AlertCircle } from 'lucide-react';

interface DenomCount { denomination: number; count: number }
interface Row {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  netPay: number;
  denominations: DenomCount[];
}
interface Register {
  runId: string;
  rows: Row[];
  totals: { totalNet: number; employeeCount: number; denominations: DenomCount[] };
}

const zar = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const DENOM_LABELS: Record<number, string> = {
  200: 'R200', 100: 'R100', 50: 'R50', 20: 'R20', 10: 'R10',
  5: 'R5', 2: 'R2', 1: 'R1',
  0.5: '50c', 0.2: '20c', 0.1: '10c', 0.05: '5c',
};

export default function CashRegisterPage() {
  const router = useRouter();
  const { id } = router.query;
  const runId = typeof id === 'string' ? id : '';

  const [reg, setReg] = useState<Register | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/cash-register`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? `HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      setReg((json.data ?? json) as Register);
    } finally {
      setLoading(false);
    }
  }, [runId]);
  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <Link href={`/payroll/runs/${runId}`} className="inline-flex items-center gap-1 text-sm text-sky-500 hover:text-sky-400">
          <ArrowLeft className="h-4 w-4" /> Back to run
        </Link>

        <div className="flex items-center gap-3">
          <Banknote className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Cash Pay Register</h1>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" />Loading register...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />{error}
          </div>
        ) : reg === null ? null : reg.rows.length === 0 ? (
          <div className="text-sm text-[var(--ff-text-secondary)]">
            No cash-paid employees in this run. Mark an employee&apos;s payment method as &quot;cash&quot; on their detail page.
          </div>
        ) : (
          <>
            <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-3">
                Totals — {reg.totals.employeeCount} cash employee{reg.totals.employeeCount === 1 ? '' : 's'}, {zar(reg.totals.totalNet)}
              </h2>
              <div className="grid grid-cols-4 md:grid-cols-6 gap-2 text-sm">
                {reg.totals.denominations.filter(d => d.count > 0).map(d => (
                  <div key={d.denomination}
                    className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2">
                    <div className="text-xs text-[var(--ff-text-secondary)]">{DENOM_LABELS[d.denomination] ?? d.denomination}</div>
                    <div className="text-lg font-semibold text-[var(--ff-text-primary)]">{d.count}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-[var(--ff-text-secondary)] bg-[var(--ff-surface-secondary)]">
                    <tr>
                      <th className="px-3 py-2">Emp #</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2 text-right">Net pay</th>
                      {reg.totals.denominations.map(d => (
                        <th key={d.denomination} className="px-2 py-2 text-right text-xs">
                          {DENOM_LABELS[d.denomination] ?? d.denomination}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
                    {reg.rows.map(row => (
                      <tr key={row.employeeId}>
                        <td className="px-3 py-2 font-mono text-xs">{row.employeeNumber}</td>
                        <td className="px-3 py-2">{row.firstName} {row.lastName}</td>
                        <td className="px-3 py-2 text-right font-medium">{zar(row.netPay)}</td>
                        {row.denominations.map(d => (
                          <td key={d.denomination} className="px-2 py-2 text-right text-xs text-[var(--ff-text-secondary)]">
                            {d.count > 0 ? d.count : '·'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  );
}
