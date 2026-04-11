/**
 * UIF Declaration Page
 * Route: /payroll/uif
 *
 * Monthly UIF contribution declaration and SARS-format CSV export.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { formatCurrency } from '@/utils/formatters';
import { Shield, Loader2, AlertCircle, Download, CheckCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

// ── Types ─────────────────────────────────────────────────────────────────────

interface UifEmployeeRow {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  id_number: string;
  gross_salary: number;
  uif_employee: number;
  uif_employer: number;
  total_uif: number;
}

interface UifDeclarationResult {
  month: string;
  total_employees: number;
  total_uif_employee: number;
  total_uif_employer: number;
  grand_total: number;
  employees: UifEmployeeRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentMonthStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function buildMonthOptions(): string[] {
  const opts: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return opts;
}

function formatMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, accent = false }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${accent ? 'border-teal-500/40 bg-teal-500/10' : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]'}`}>
      <p className="text-xs text-[var(--ff-text-secondary)] uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-semibold font-mono ${accent ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
        {typeof value === 'number' && label.toLowerCase().includes('employee') && !label.toLowerCase().includes('uif')
          ? value
          : formatCurrency(value)}
      </p>
      {sub && <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">{sub}</p>}
    </div>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <p className="text-xs text-[var(--ff-text-secondary)] uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-semibold text-[var(--ff-text-primary)]">{value}</p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UifPage() {
  const MONTH_OPTIONS = buildMonthOptions();
  const [month, setMonth] = useState<string>(getCurrentMonthStr());
  const [data, setData] = useState<UifDeclarationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const loadDeclaration = useCallback(async (m: string) => {
    setLoading(true);
    setError('');
    setSubmitted(false);
    try {
      const res = await apiFetch(`/api/payroll/uif-declaration?month=${m}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: UifDeclarationResult };
      setData(json.data);
    } catch {
      setError('Failed to load UIF declaration data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDeclaration(month);
  }, [month, loadDeclaration]);

  async function handleExportCsv() {
    setExporting(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/uif-declaration?action=export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `UIF_Declaration_${month}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to export UIF CSV');
    } finally {
      setExporting(false);
    }
  }

  const employees = data?.employees ?? [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Shield className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">UIF Declaration</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Monthly Unemployment Insurance Fund contribution report</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleExportCsv}
                disabled={exporting || employees.length === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export UIF CSV
              </button>
              <button
                onClick={() => setSubmitted(v => !v)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  submitted
                    ? 'border-teal-500/40 bg-teal-500/10 text-teal-400'
                    : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]'
                }`}
              >
                <CheckCircle className="h-4 w-4" />
                {submitted ? 'Submitted' : 'Mark as Submitted'}
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Month picker */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-[var(--ff-text-secondary)]">Declaration month:</label>
            <select
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
            >
              {MONTH_OPTIONS.map(m => (
                <option key={m} value={m}>{formatMonthLabel(m)}</option>
              ))}
            </select>
            {submitted && (
              <span className="flex items-center gap-1 text-sm text-teal-400">
                <CheckCircle className="h-4 w-4" />
                Marked as submitted
              </span>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-red-400">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {/* Summary cards */}
          {!loading && data && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <CountCard label="Total Employees" value={data.total_employees} />
              <SummaryCard label="UIF (Employee)" value={data.total_uif_employee} sub="1% of gross (capped)" />
              <SummaryCard label="UIF (Employer)" value={data.total_uif_employer} sub="1% of gross (capped)" />
              <SummaryCard label="Grand Total" value={data.grand_total} accent />
            </div>
          )}

          {/* Detail table */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
                Employee Detail — {formatMonthLabel(month)}
              </h2>
              {!loading && data && (
                <span className="text-sm text-[var(--ff-text-secondary)]">
                  {data.total_employees} employee{data.total_employees !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : employees.length === 0 ? (
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] py-12 text-center">
                <Shield className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
                <p className="text-sm text-[var(--ff-text-secondary)]">No UIF contributions for {formatMonthLabel(month)}.</p>
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Ensure payroll runs have been processed and completed for this month.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-auto bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employee</th>
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">ID Number</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Gross Salary</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF Employee</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF Employer</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Total UIF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map(emp => (
                      <tr key={emp.employee_id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                        <td className="py-3 px-4">
                          <p className="font-medium text-[var(--ff-text-primary)]">{emp.employee_name}</p>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">{emp.employee_number}</p>
                        </td>
                        <td className="py-3 px-4 text-[var(--ff-text-secondary)] font-mono text-xs">
                          {emp.id_number || '—'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp.gross_salary)}</td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp.uif_employee)}</td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(emp.uif_employer)}</td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-teal-400">{formatCurrency(emp.total_uif)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <td className="py-3 px-4 font-semibold text-[var(--ff-text-primary)]" colSpan={2}>Totals</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">
                        {formatCurrency(employees.reduce((s, e) => s + e.gross_salary, 0))}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">
                        {data && formatCurrency(data.total_uif_employee)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">
                        {data && formatCurrency(data.total_uif_employer)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-teal-400">
                        {data && formatCurrency(data.grand_total)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs text-[var(--ff-text-tertiary)]">
            UIF rate: 1% employee + 1% employer, capped at R177.12/month each. Declaration due by the 7th of the following month.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
