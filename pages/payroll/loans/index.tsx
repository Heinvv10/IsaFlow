/**
 * Employee Loans list. Route: /payroll/loans
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { Banknote, Loader2, AlertCircle, Plus } from 'lucide-react';

interface LoanRow {
  id: string;
  employeeId: string;
  loanNumber: string;
  description: string;
  principal: number;
  outstandingBalance: number;
  annualInterestRate: number;
  termMonths: number;
  method: 'declining_balance' | 'straight_line' | 'interest_free';
  status: 'active' | 'settled' | 'written_off' | 'cancelled';
  startDate: string;
}

function StatusBadge({ status }: { status: LoanRow['status'] }) {
  const c: Record<LoanRow['status'], string> = {
    active: 'bg-blue-500/10 text-blue-400',
    settled: 'bg-emerald-500/10 text-emerald-400',
    written_off: 'bg-red-500/10 text-red-400',
    cancelled: 'bg-gray-500/10 text-gray-400',
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c[status]}`}>{status.replace('_', ' ')}</span>;
}

export default function LoansListPage() {
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | LoanRow['status']>('');

  const [componentsMissing, setComponentsMissing] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      const [loansRes, compRes] = await Promise.all([
        apiFetch(`/api/payroll/loans${qs}`),
        apiFetch('/api/payroll/components'),
      ]);
      if (!loansRes.ok) throw new Error(`HTTP ${loansRes.status}`);
      const json = await loansRes.json();
      setLoans((json.data ?? json) as LoanRow[]);
      if (compRes.ok) {
        const compJson = await compRes.json();
        const components = (compJson.data ?? compJson) as Array<{ sarsSourceCode: string }>;
        const codes = new Set(components.map(c => c.sarsSourceCode));
        setComponentsMissing(!codes.has('LOAN') || !codes.has('3801'));
      }
    } catch {
      setError('Failed to load loans');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  async function seedComponents(): Promise<void> {
    setSeeding(true);
    try {
      const res = await apiFetch('/api/payroll/loans/setup-components', { method: 'POST' });
      if (res.ok) await load();
    } finally {
      setSeeding(false);
    }
  }

  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Banknote className="h-6 w-6 text-emerald-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Employee Loans</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Loan agreements, amortisation, and in-period deductions</p>
            </div>
          </div>
          <Link href="/payroll/loans/new" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium">
            <Plus className="h-4 w-4" /> New Loan
          </Link>
        </div>

        <div className="p-6 space-y-4">
          {componentsMissing && !loading && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <div className="text-amber-300">
                Loan payslip components not configured. Without these, loan payments record but don&apos;t appear on payslips.
              </div>
              <button onClick={seedComponents} disabled={seeding}
                className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50">
                {seeding ? 'Creating...' : 'Create loan components'}
              </button>
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="text-sm text-[var(--ff-text-secondary)]">Status</label>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as LoanRow['status'] | '')}
              className="rounded-md bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 text-[var(--ff-text-primary)]">
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="settled">Settled</option>
              <option value="written_off">Written off</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-emerald-500" /></div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
          ) : loans.length === 0 ? (
            <div className="text-center py-16">
              <Banknote className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No loans yet</p>
              <Link href="/payroll/loans/new" className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium">
                <Plus className="h-4 w-4" /> Create first loan
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)]">Loan #</th>
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)]">Description</th>
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)]">Method</th>
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)]">Status</th>
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)] text-right">Rate</th>
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)] text-right">Principal</th>
                    <th className="py-3 px-4 font-medium text-[var(--ff-text-secondary)] text-right">Outstanding</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {loans.map(l => (
                    <tr key={l.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4 font-mono text-[var(--ff-text-primary)]">{l.loanNumber}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{l.description}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{l.method.replace('_', ' ')}</td>
                      <td className="py-3 px-4"><StatusBadge status={l.status} /></td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{(l.annualInterestRate * 100).toFixed(2)}%</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(l.principal)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(l.outstandingBalance)}</td>
                      <td className="py-3 px-4 text-right">
                        <Link href={`/payroll/loans/${l.id}`} className="text-emerald-400 hover:text-emerald-300 text-xs font-medium">Open</Link>
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
