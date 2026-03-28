/**
 * New Payroll Run Page
 * Select period, preview employees, process payroll.
 * Route: /payroll/runs/new
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { CalendarDays, Loader2, ArrowLeft, Play, Users, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { notify } from '@/utils/toast';

interface EmployeePreview {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  pay_structure: {
    basic_salary: number;
    travel_allowance: number;
    housing_allowance: number;
    cell_allowance: number;
    other_allowances: number;
  } | null;
}

interface PayslipResult {
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  gross_pay: number;
  paye: number;
  uif_employee: number;
  sdl: number;
  medical_aid: number;
  retirement_fund: number;
  total_deductions: number;
  net_pay: number;
}

interface PayrollRunResult {
  id: string;
  total_gross: number;
  total_paye: number;
  total_uif_employee: number;
  total_uif_employer: number;
  total_sdl: number;
  total_net: number;
  total_company_cost: number;
  payslips: PayslipResult[];
}

function formatCurrency(amount: number): string {
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getDefaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  return {
    start: start.toISOString().split('T')[0] || '',
    end: end.toISOString().split('T')[0] || '',
  };
}

export default function NewPayrollRunPage() {
  const router = useRouter();
  const defaultPeriod = getDefaultPeriod();

  const [periodStart, setPeriodStart] = useState(defaultPeriod.start);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.end);
  const [employees, setEmployees] = useState<EmployeePreview[]>([]);
  const [isLoadingEmps, setIsLoadingEmps] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<PayrollRunResult | null>(null);
  const [error, setError] = useState('');

  // Load active employees for preview
  useEffect(() => {
    async function loadEmployees() {
      setIsLoadingEmps(true);
      try {
        const res = await fetch('/api/payroll/employees?status=active');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setEmployees((json.data ?? json) as EmployeePreview[]);
      } catch {
        setError('Failed to load employees');
      } finally {
        setIsLoadingEmps(false);
      }
    }
    loadEmployees();
  }, []);

  async function handleRunPayroll() {
    if (!periodStart || !periodEnd) {
      notify.error('Please select a period');
      return;
    }
    if (new Date(periodEnd) < new Date(periodStart)) {
      notify.error('End date must be after start date');
      return;
    }

    setIsProcessing(true);
    setError('');
    try {
      const res = await fetch('/api/payroll/payroll-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_start: periodStart, period_end: periodEnd }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? json.message ?? `HTTP ${res.status}`);

      const data = json.data ?? json;
      setResult(data as PayrollRunResult);
      notify.success('Payroll run created successfully');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to process payroll';
      setError(message);
      notify.error(message);
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
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
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Payroll Run</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Process payroll for a period</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl">
          {!result ? (
            <>
              {/* Period Selection */}
              <div className="mb-8 p-6 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Pay Period</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Period Start</label>
                    <input
                      type="date"
                      value={periodStart}
                      onChange={(e) => setPeriodStart(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Period End</label>
                    <input
                      type="date"
                      value={periodEnd}
                      onChange={(e) => setPeriodEnd(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                    />
                  </div>
                </div>
              </div>

              {/* Employee Preview */}
              <div className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Users className="h-5 w-5 text-teal-500" />
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                    Employees to Process ({employees.length})
                  </h2>
                </div>

                {isLoadingEmps ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
                  </div>
                ) : employees.length === 0 ? (
                  <div className="text-center py-8 text-[var(--ff-text-tertiary)]">
                    <p>No active employees found. Add employees first.</p>
                    <Link
                      href="/payroll/employees/new"
                      className="inline-flex items-center gap-2 mt-3 text-teal-400 hover:text-teal-300 text-sm font-medium"
                    >
                      Add Employee
                    </Link>
                  </div>
                ) : (
                  <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                          <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
                          <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                          <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Department</th>
                          <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Basic Salary</th>
                          <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Total Package</th>
                        </tr>
                      </thead>
                      <tbody>
                        {employees.map((emp) => {
                          const ps = emp.pay_structure;
                          const total = ps
                            ? ps.basic_salary + ps.travel_allowance + ps.housing_allowance + ps.cell_allowance + ps.other_allowances
                            : 0;
                          return (
                            <tr key={emp.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                              <td className="py-2 px-4 text-[var(--ff-text-secondary)] font-mono text-xs">{emp.employee_number}</td>
                              <td className="py-2 px-4 text-[var(--ff-text-primary)]">{emp.first_name} {emp.last_name}</td>
                              <td className="py-2 px-4 text-[var(--ff-text-secondary)]">{emp.department || '-'}</td>
                              <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{ps ? formatCurrency(ps.basic_salary) : '-'}</td>
                              <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)]">{ps ? formatCurrency(total) : '-'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {error && (
                <div className="mb-6 flex items-center gap-2 text-red-400 text-sm">
                  <AlertCircle className="h-4 w-4" />
                  <span>{error}</span>
                </div>
              )}

              {/* Run Button */}
              <button
                onClick={handleRunPayroll}
                disabled={isProcessing || employees.length === 0}
                className="flex items-center gap-2 px-6 py-3 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run Payroll
              </button>
            </>
          ) : (
            <>
              {/* Results */}
              <div className="mb-8">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Payroll Run Results</h2>

                {/* Summary Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                  <StatCard label="Total Gross" value={formatCurrency(result.total_gross)} />
                  <StatCard label="Total PAYE" value={formatCurrency(result.total_paye)} />
                  <StatCard label="Total Net" value={formatCurrency(result.total_net)} highlight />
                  <StatCard label="Company Cost" value={formatCurrency(result.total_company_cost)} />
                  <StatCard label="UIF (Employee)" value={formatCurrency(result.total_uif_employee)} />
                  <StatCard label="UIF (Employer)" value={formatCurrency(result.total_uif_employer)} />
                  <StatCard label="SDL" value={formatCurrency(result.total_sdl)} />
                  <StatCard label="Employees" value={String(result.payslips.length)} />
                </div>

                {/* Payslips Table */}
                <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                        <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employee</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Gross</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">PAYE</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Medical</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Retirement</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Deductions</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Net Pay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.payslips.map((slip, i) => (
                        <tr key={i} className="border-b border-[var(--ff-border-primary)] last:border-0">
                          <td className="py-2 px-4 text-[var(--ff-text-primary)]">
                            <span className="text-xs text-[var(--ff-text-tertiary)] mr-2">{slip.employee_number}</span>
                            {slip.first_name} {slip.last_name}
                          </td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(slip.gross_pay)}</td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.paye)}</td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.uif_employee)}</td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.medical_aid)}</td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.retirement_fund)}</td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(slip.total_deductions)}</td>
                          <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(slip.net_pay)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Navigation buttons */}
              <div className="flex items-center gap-3">
                <Link
                  href={`/payroll/runs/${result.id}`}
                  className="px-6 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
                >
                  View Run Details
                </Link>
                <Link
                  href="/payroll/runs"
                  className="px-6 py-2.5 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors"
                >
                  Back to Runs
                </Link>
              </div>
            </>
          )}
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
