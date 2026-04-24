/**
 * Loan detail — schedule grid + payment history + close actions.
 * Route: /payroll/loans/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { Banknote, Loader2, AlertCircle, ArrowLeft, CheckCircle2, XCircle } from 'lucide-react';

interface ScheduleRow {
  id: string;
  sequence: number;
  duePeriodYear: number;
  duePeriodMonth: number;
  openingBalance: number;
  interest: number;
  principal: number;
  installment: number;
  closingBalance: number;
  paidFlag: boolean;
}

interface PaymentRow {
  id: string;
  periodYear: number;
  periodMonth: number;
  openingBalance: number;
  interestCharged: number;
  principalPaid: number;
  fringeBenefit: number;
  closingBalance: number;
}

interface Loan {
  id: string;
  loanNumber: string;
  description: string;
  employeeId: string;
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  method: 'declining_balance' | 'straight_line' | 'interest_free';
  status: 'active' | 'settled' | 'written_off' | 'cancelled';
  outstandingBalance: number;
  totalInterestCharged: number;
  totalPrincipalPaid: number;
  startDate: string;
  firstPeriodYear: number;
  firstPeriodMonth: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function LoanDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [loan, setLoan] = useState<Loan | null>(null);
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/loans/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const payload = (json.data ?? json) as { loan: Loan; schedule: ScheduleRow[]; payments: PaymentRow[] };
      setLoan(payload.loan);
      setSchedule(payload.schedule);
      setPayments(payload.payments);
    } catch {
      setError('Failed to load loan');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function close(status: 'settled' | 'written_off' | 'cancelled'): Promise<void> {
    const label = status === 'settled' ? 'settle' : status === 'written_off' ? 'write off' : 'cancel';
    if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} this loan? Cannot be reopened.`)) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/payroll/loans/${id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message ?? json.message ?? 'Close failed');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <AppLayout><div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-emerald-500" /></div></AppLayout>;
  }
  if (!loan) {
    return <AppLayout><div className="flex items-center justify-center gap-2 text-red-400 py-12"><AlertCircle className="h-5 w-5" /><span>{error || 'Loan not found'}</span></div></AppLayout>;
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/payroll/loans" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-emerald-500/10"><Banknote className="h-6 w-6 text-emerald-500" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">{loan.loanNumber} — {loan.description}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                {loan.method.replace('_', ' ')} · {(loan.annualInterestRate * 100).toFixed(2)}% · {loan.termMonths} months · {loan.status}
              </p>
            </div>
          </div>
          {loan.status === 'active' && (
            <div className="flex gap-2">
              <button onClick={() => close('settled')} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50">
                <CheckCircle2 className="h-4 w-4" /> Settle
              </button>
              <button onClick={() => close('written_off')} disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/40 text-red-400 text-sm font-medium hover:bg-red-500/10 disabled:opacity-50">
                <XCircle className="h-4 w-4" /> Write off
              </button>
            </div>
          )}
        </div>

        <div className="p-6 space-y-6">
          {error && <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3"><AlertCircle className="h-4 w-4" />{error}</div>}

          <div className="grid grid-cols-4 gap-4">
            <Stat label="Principal" value={formatCurrency(loan.principal)} />
            <Stat label="Outstanding" value={formatCurrency(loan.outstandingBalance)} highlight />
            <Stat label="Interest paid" value={formatCurrency(loan.totalInterestCharged)} />
            <Stat label="Principal paid" value={formatCurrency(loan.totalPrincipalPaid)} />
          </div>

          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] text-sm font-medium text-[var(--ff-text-primary)]">
              Amortisation schedule
            </div>
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left sticky top-0">
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">#</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Period</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Opening</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Interest</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Principal</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Installment</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Closing</th>
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map(r => (
                    <tr key={r.id} className={`border-b border-[var(--ff-border-primary)] last:border-0 ${r.paidFlag ? 'opacity-50' : ''}`}>
                      <td className="py-1.5 px-3 font-mono text-[var(--ff-text-secondary)]">{r.sequence}</td>
                      <td className="py-1.5 px-3 text-[var(--ff-text-secondary)]">{MONTHS[r.duePeriodMonth - 1]} {r.duePeriodYear}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(r.openingBalance)}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(r.interest)}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(r.principal)}</td>
                      <td className="py-1.5 px-3 text-right font-mono font-medium">{formatCurrency(r.installment)}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(r.closingBalance)}</td>
                      <td className="py-1.5 px-3">{r.paidFlag && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {payments.length > 0 && (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] text-sm font-medium text-[var(--ff-text-primary)]">
                Payments made
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Period</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Interest</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Principal</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Fringe (3801)</th>
                    <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-1.5 px-3">{MONTHS[p.periodMonth - 1]} {p.periodYear}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(p.interestCharged)}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(p.principalPaid)}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(p.fringeBenefit)}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(p.closingBalance)}</td>
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

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <div className="text-xs text-[var(--ff-text-secondary)]">{label}</div>
      <div className={`mt-1 text-lg font-semibold font-mono ${highlight ? 'text-emerald-400' : 'text-[var(--ff-text-primary)]'}`}>{value}</div>
    </div>
  );
}
