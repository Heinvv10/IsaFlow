/**
 * EMP201 / SDL Dashboard Page
 * Route: /payroll/emp201
 *
 * Shows SARS EMP201 monthly return summary (PAYE + UIF + SDL totals)
 * and an annual SDL breakdown table.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { formatCurrency } from '@/utils/formatters';
import { FileText, Loader2, AlertCircle, Printer } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

// ── Types ────────────────────────────────────────────────────────────────────

interface Emp201Result {
  month: string;
  totalGross: number;
  totalPaye: number;
  totalUifEmployee: number;
  totalUifEmployer: number;
  totalSdl: number;
  totalLiability: number;
  employeeCount: number;
  payrollRunIds: string[];
}

interface SdlMonthResult {
  month: string;
  gross: number;
  sdl: number;
  employeeCount: number;
}

interface SdlYearResult {
  year: string;
  months: SdlMonthResult[];
  yearTotal: { gross: number; sdl: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentMonthStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getCurrentYear(): string {
  return String(new Date().getFullYear());
}

function formatMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
}

function formatShortMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string;
  amount: number;
  accent?: boolean;
}

function SummaryCard({ label, amount, accent = false }: SummaryCardProps) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        accent
          ? 'border-teal-500/40 bg-teal-500/10'
          : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]'
      }`}
    >
      <p className="text-xs text-[var(--ff-text-secondary)] uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-xl font-semibold font-mono ${accent ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
        {formatCurrency(amount)}
      </p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Emp201Page() {
  const [selectedMonth, setSelectedMonth] = useState<string>(getCurrentMonthStr());
  const [selectedYear]  = useState<string>(getCurrentYear());

  const [emp201, setEmp201] = useState<Emp201Result | null>(null);
  const [sdl, setSdl]       = useState<SdlYearResult | null>(null);
  const [loading, setLoading]     = useState(false);
  const [sdlLoading, setSdlLoading] = useState(false);
  const [error, setError]         = useState('');
  const [sdlError, setSdlError]   = useState('');

  // Build month options covering the full historical range where payroll
  // runs may exist (5 years back) plus the next 3 months of forward-dated
  // periods. Anything earlier can still be reached by typing into a
  // future filter control.
  const monthOptions: string[] = [];
  const now = new Date();
  const earliest = new Date(now.getFullYear() - 5, 0, 1);
  const latest = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const cursor = new Date(earliest);
  while (cursor <= latest) {
    monthOptions.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
    );
    cursor.setMonth(cursor.getMonth() + 1);
  }
  // Show most-recent-first so the default selection still lands on the current month
  monthOptions.reverse();

  const loadEmp201 = useCallback(async (month: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/payroll-emp201?month=${month}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: Emp201Result };
      setEmp201(json.data);
    } catch {
      setError('Failed to load EMP201 data');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSdl = useCallback(async (year: string) => {
    setSdlLoading(true);
    setSdlError('');
    try {
      const res = await apiFetch(`/api/payroll/payroll-sdl?year=${year}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: SdlYearResult };
      setSdl(json.data);
    } catch {
      setSdlError('Failed to load SDL report');
    } finally {
      setSdlLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEmp201(selectedMonth);
  }, [selectedMonth, loadEmp201]);

  useEffect(() => {
    loadSdl(selectedYear);
  }, [selectedYear, loadSdl]);

  const handlePrint = () => {
    window.print();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] print:border-0">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileText className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">EMP201 / SDL Return</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Monthly PAYE, UIF and SDL liability for SARS submission
                </p>
              </div>
            </div>
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] text-sm font-medium transition-colors print:hidden"
            >
              <Printer className="h-4 w-4" />
              Print / Export
            </button>
          </div>
        </div>

        <div className="p-6 space-y-8 print:p-4">
          {/* Month selector */}
          <div className="flex items-center gap-3 print:hidden">
            <label className="text-sm font-medium text-[var(--ff-text-secondary)]">
              Return month:
            </label>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
            >
              {monthOptions.map((m) => (
                <option key={m} value={m}>{formatMonthLabel(m)}</option>
              ))}
            </select>
          </div>

          {/* EMP201 Summary */}
          <section>
            <div className="flex items-center justify-between mb-4 print:mb-2">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
                EMP201 Summary — {formatMonthLabel(selectedMonth)}
              </h2>
              {emp201 && (
                <span className="text-sm text-[var(--ff-text-secondary)]">
                  {emp201.employeeCount} employee{emp201.employeeCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 text-red-400 py-6">
                <AlertCircle className="h-5 w-5" />
                <span className="text-sm">{error}</span>
              </div>
            ) : emp201 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <SummaryCard label="Gross Payroll"     amount={emp201.totalGross} />
                <SummaryCard label="PAYE"              amount={emp201.totalPaye} />
                <SummaryCard label="UIF (Employee)"    amount={emp201.totalUifEmployee} />
                <SummaryCard label="UIF (Employer)"    amount={emp201.totalUifEmployer} />
                <SummaryCard label="SDL (1%)"          amount={emp201.totalSdl} />
                <SummaryCard label="Total Liability"   amount={emp201.totalLiability} accent />
              </div>
            ) : null}

            {emp201 && emp201.payrollRunIds.length === 0 && !loading && (
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-4">
                No payroll runs found for {formatMonthLabel(selectedMonth)}.
              </p>
            )}
          </section>

          {/* EMP201 Breakdown Table */}
          {emp201 && emp201.totalGross > 0 && (
            <section>
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4 print:mb-2">
                Liability Breakdown
              </h2>
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Component</th>
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Description</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-[var(--ff-border-primary)]">
                      <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">PAYE</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">Pay As You Earn tax withheld</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp201.totalPaye)}</td>
                    </tr>
                    <tr className="border-b border-[var(--ff-border-primary)]">
                      <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">UIF (Employee)</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">1% deducted from employee (capped R177.12)</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp201.totalUifEmployee)}</td>
                    </tr>
                    <tr className="border-b border-[var(--ff-border-primary)]">
                      <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">UIF (Employer)</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">1% employer contribution (capped R177.12)</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp201.totalUifEmployer)}</td>
                    </tr>
                    <tr className="border-b border-[var(--ff-border-primary)]">
                      <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">SDL</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">Skills Development Levy — 1% of gross leviable earnings</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp201.totalSdl)}</td>
                    </tr>
                    <tr className="bg-teal-500/5">
                      <td className="py-3 px-4 font-semibold text-teal-400">Total Payable</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">PAYE + UIF (both) + SDL</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-teal-400">{formatCurrency(emp201.totalLiability)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* SDL Annual Breakdown */}
          <section>
            <div className="flex items-center justify-between mb-4 print:mb-2">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
                SDL Annual Breakdown — {selectedYear}
              </h2>
              {sdl && (
                <span className="text-sm text-[var(--ff-text-secondary)]">
                  Year total SDL: {formatCurrency(sdl.yearTotal.sdl)}
                </span>
              )}
            </div>

            {sdlLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : sdlError ? (
              <div className="flex items-center gap-2 text-red-400 py-6">
                <AlertCircle className="h-5 w-5" />
                <span className="text-sm">{sdlError}</span>
              </div>
            ) : sdl ? (
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Month</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employees</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Gross Leviable</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">SDL (1%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sdl.months.map((m) => (
                      <tr
                        key={m.month}
                        className={`border-b border-[var(--ff-border-primary)] last:border-0 transition-colors ${
                          m.month === selectedMonth
                            ? 'bg-teal-500/5'
                            : 'hover:bg-[var(--ff-bg-tertiary)]'
                        }`}
                      >
                        <td className={`py-3 px-4 font-medium ${m.month === selectedMonth ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
                          {formatShortMonth(m.month)}
                        </td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">
                          {m.employeeCount > 0 ? m.employeeCount : '—'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">
                          {m.gross > 0 ? formatCurrency(m.gross) : '—'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">
                          {m.sdl > 0 ? formatCurrency(m.sdl) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <td className="py-3 px-4 font-semibold text-[var(--ff-text-primary)]">Year Total</td>
                      <td className="py-3 px-4" />
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">
                        {formatCurrency(sdl.yearTotal.gross)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-teal-400">
                        {formatCurrency(sdl.yearTotal.sdl)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : null}
          </section>

          {/* SARS reference note */}
          <p className="text-xs text-[var(--ff-text-tertiary)] print:mt-4">
            SDL rate: 1% — UIF rate: 1% employee + 1% employer (capped at R177.12/month each) — SARS EMP201 due 7th of following month.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
