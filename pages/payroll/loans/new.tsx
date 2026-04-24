/**
 * New Employee Loan — form with live schedule preview.
 * Route: /payroll/loans/new
 */
import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { Banknote, Save, Loader2 } from 'lucide-react';

interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

interface PreviewRow {
  sequence: number;
  duePeriodYear: number;
  duePeriodMonth: number;
  openingBalance: number;
  interest: number;
  principal: number;
  installment: number;
  closingBalance: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function previewSchedule(params: {
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  method: 'declining_balance' | 'straight_line' | 'interest_free';
  firstPeriodYear: number;
  firstPeriodMonth: number;
}): PreviewRow[] {
  const { principal, termMonths, method, firstPeriodYear, firstPeriodMonth } = params;
  const monthlyRate = params.annualInterestRate / 12;
  const rows: PreviewRow[] = [];
  let balance = principal;
  let y = firstPeriodYear;
  let m = firstPeriodMonth;
  const decliningInstallment = method === 'declining_balance' && monthlyRate > 0
    ? (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths))
    : principal / termMonths;
  const straightPrincipal = principal / termMonths;

  for (let seq = 1; seq <= termMonths; seq++) {
    const opening = balance;
    let interest = 0;
    let principalPortion = 0;
    if (method === 'declining_balance') {
      interest = opening * monthlyRate;
      principalPortion = decliningInstallment - interest;
    } else if (method === 'straight_line') {
      interest = opening * monthlyRate;
      principalPortion = straightPrincipal;
    } else {
      principalPortion = straightPrincipal;
    }
    if (seq === termMonths) principalPortion = opening;
    const installment = principalPortion + interest;
    const closing = Math.max(0, opening - principalPortion);
    rows.push({
      sequence: seq,
      duePeriodYear: y,
      duePeriodMonth: m,
      openingBalance: round2(opening),
      interest: round2(interest),
      principal: round2(principalPortion),
      installment: round2(installment),
      closingBalance: round2(closing),
    });
    balance = closing;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return rows;
}

export default function NewLoanPage() {
  const router = useRouter();
  const now = new Date();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [loanNumber, setLoanNumber] = useState('');
  const [description, setDescription] = useState('');
  const [principal, setPrincipal] = useState<number>(0);
  const [annualInterestRate, setAnnualInterestRate] = useState<number>(0);
  const [termMonths, setTermMonths] = useState<number>(12);
  const [method, setMethod] = useState<'declining_balance' | 'straight_line' | 'interest_free'>('declining_balance');
  const [firstPeriodYear, setFirstPeriodYear] = useState<number>(now.getFullYear());
  const [firstPeriodMonth, setFirstPeriodMonth] = useState<number>(now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2);
  const [startDate, setStartDate] = useState<string>(now.toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const res = await apiFetch('/api/payroll/employees');
      if (res.ok) {
        const json = await res.json();
        setEmployees((json.data ?? json) as Employee[]);
      }
    })();
  }, []);

  const schedule = useMemo(() => {
    if (!principal || !termMonths) return [];
    return previewSchedule({
      principal,
      annualInterestRate,
      termMonths,
      method,
      firstPeriodYear,
      firstPeriodMonth,
    });
  }, [principal, annualInterestRate, termMonths, method, firstPeriodYear, firstPeriodMonth]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    if (!employeeId || !loanNumber.trim() || !description.trim() || principal <= 0 || termMonths < 1) {
      setError('Fill all required fields');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/payroll/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId, loanNumber: loanNumber.trim(), description: description.trim(),
          principal, annualInterestRate, termMonths, method,
          startDate, firstPeriodYear, firstPeriodMonth,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? json.message ?? 'Create failed');
        return;
      }
      const id = (json.data ?? json).id as string;
      await router.push(`/payroll/loans/${id}`);
    } catch {
      setError('Create failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10"><Banknote className="h-6 w-6 text-emerald-500" /></div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Loan</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Employee loan agreement with auto-generated amortisation</p>
          </div>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form onSubmit={submit} className="space-y-4 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Employee</label>
              <select value={employeeId} onChange={e => setEmployeeId(e.target.value)}
                className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
                <option value="">Select employee</option>
                {employees.map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.employeeNumber} — {emp.firstName} {emp.lastName}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Loan #</label>
                <input value={loanNumber} onChange={e => setLoanNumber(e.target.value)}
                  placeholder="L-0001"
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Start date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]" />
              </div>
            </div>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Description</label>
              <input value={description} onChange={e => setDescription(e.target.value)}
                placeholder="Bridging loan"
                className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]" />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Principal</label>
                <input type="number" step="0.01" value={principal || ''} onChange={e => setPrincipal(Number(e.target.value))}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)] font-mono" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Annual rate</label>
                <input type="number" step="0.0001" value={annualInterestRate || ''} onChange={e => setAnnualInterestRate(Number(e.target.value))}
                  placeholder="0.075 = 7.5%"
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)] font-mono" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Term (months)</label>
                <input type="number" value={termMonths || ''} onChange={e => setTermMonths(Number(e.target.value))}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)] font-mono" />
              </div>
            </div>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Method</label>
              <select value={method} onChange={e => setMethod(e.target.value as typeof method)}
                className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
                <option value="declining_balance">Declining balance (equal installment)</option>
                <option value="straight_line">Straight line (equal principal)</option>
                <option value="interest_free">Interest free (principal only)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">First deduction month</label>
                <select value={firstPeriodMonth} onChange={e => setFirstPeriodMonth(Number(e.target.value))}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)]">
                  {MONTHS.map((mn, i) => <option key={mn} value={i + 1}>{mn}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">First deduction year</label>
                <input type="number" value={firstPeriodYear} onChange={e => setFirstPeriodYear(Number(e.target.value))}
                  className="w-full rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] text-sm px-3 py-2 text-[var(--ff-text-primary)] font-mono" />
              </div>
            </div>

            {error && <div className="text-sm text-red-400">{error}</div>}

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => router.back()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">Cancel</button>
              <button type="submit" disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Create
              </button>
            </div>
          </form>

          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] text-sm font-medium text-[var(--ff-text-primary)]">
              Schedule preview {schedule.length > 0 && <span className="text-[var(--ff-text-secondary)] font-normal">({schedule.length} periods, total {formatCurrency(schedule.reduce<number>((s: number, r) => s + r.installment, 0))})</span>}
            </div>
            {schedule.length === 0 ? (
              <div className="p-6 text-center text-sm text-[var(--ff-text-secondary)]">Fill principal + term to preview.</div>
            ) : (
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left sticky top-0">
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">#</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)]">Period</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Interest</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Principal</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Installment</th>
                      <th className="py-2 px-3 font-medium text-[var(--ff-text-secondary)] text-right">Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map(r => (
                      <tr key={r.sequence} className="border-b border-[var(--ff-border-primary)] last:border-0">
                        <td className="py-1.5 px-3 font-mono text-[var(--ff-text-secondary)]">{r.sequence}</td>
                        <td className="py-1.5 px-3 text-[var(--ff-text-secondary)]">{MONTHS[r.duePeriodMonth - 1]} {r.duePeriodYear}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(r.interest)}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{formatCurrency(r.principal)}</td>
                        <td className="py-1.5 px-3 text-right font-mono font-medium">{formatCurrency(r.installment)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(r.closingBalance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
