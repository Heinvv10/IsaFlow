/**
 * EMP201 Form Page
 * Monthly PAYE/UIF/SDL return with auto-populated payroll data,
 * save draft and mark submitted actions.
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  FileText, Loader2, Save, Send, Download,
  ChevronLeft, ChevronDown, ChevronRight, Users, AlertTriangle,
} from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface EMP201PayrollRun {
  id: string;
  runDate: string;
  employeeCount: number;
  grossPay: number;
  paye: number;
  uif: number;
  sdl: number;
}

interface EMP201Data {
  periodStart: string;
  periodEnd: string;
  totalPAYE: number;
  totalUIF_employee: number;
  totalUIF_employer: number;
  totalUIF: number;
  totalSDL: number;
  employeeCount: number;
  totalTaxableRemuneration: number;
  totalDeductions: number;
  payrollRuns: EMP201PayrollRun[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function getDefaultPeriod(): { from: string; to: string } {
  const now = new Date();
  // Default to previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
  const y = prevMonth.getFullYear();
  const m = String(prevMonth.getMonth() + 1).padStart(2, '0');
  return {
    from: `${y}-${m}-01`,
    to: `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

export default function EMP201Page() {
  const defaults = getDefaultPeriod();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [data, setData] = useState<EMP201Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showRuns, setShowRuns] = useState(false);
  const [sarsRef, setSarsRef] = useState('');
  const [savedId, setSavedId] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  const generate = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError('');
    setSuccess('');
    setData(null);
    setSavedId('');
    try {
      const res = await apiFetch(
        `/api/accounting/sars/sars-emp201?from=${from}&to=${to}`,
        { credentials: 'include' }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate EMP201');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  const saveDraft = async () => {
    if (!data) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-emp201', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ periodStart: from, periodEnd: to }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSavedId(json.data?.id || '');
      setSuccess('EMP201 draft saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save draft');
    } finally {
      setSaving(false);
    }
  };

  const markSubmitted = async () => {
    if (!savedId || !sarsRef.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: savedId, action: 'mark_submitted', reference: sarsRef.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSuccess('EMP201 marked as submitted to SARS');
      setShowSubmitModal(false);
      setSarsRef('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as submitted');
    } finally {
      setSubmitting(false);
    }
  };

  const exportCSV = () => {
    if (!data) return;
    const rows = [
      ['Field', 'Description', 'Amount (ZAR)'],
      ['PAYE', 'Total PAYE withheld', data.totalPAYE.toFixed(2)],
      ['UIF (Employee)', 'UIF employee contribution', data.totalUIF_employee.toFixed(2)],
      ['UIF (Employer)', 'UIF employer contribution', data.totalUIF_employer.toFixed(2)],
      ['UIF Total', 'Total UIF', data.totalUIF.toFixed(2)],
      ['SDL', 'Skills Development Levy', data.totalSDL.toFixed(2)],
      ['Employees', 'Number of employees', String(data.employeeCount)],
      ['Remuneration', 'Total taxable remuneration', data.totalTaxableRemuneration.toFixed(2)],
      ['Total', 'Total deductions payable', data.totalDeductions.toFixed(2)],
      [],
      ['Period', `${data.periodStart} to ${data.periodEnd}`],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EMP201_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const hasPayrollData = data && data.payrollRuns.length > 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/accounting/sars"
                className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
              >
                <ChevronLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Users className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">EMP201 Return</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Monthly employer declaration — PAYE, UIF and SDL
                </p>
              </div>
            </div>
            {data && (
              <button
                onClick={exportCSV}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

          {/* Period Selector */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <h2 className="text-sm font-medium text-[var(--ff-text-secondary)] mb-3">Payroll Period</h2>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm"
                />
              </div>
              <button
                onClick={generate}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Generate
              </button>
            </div>
          </div>

          {/* EMP201 Form */}
          {data && (
            <>
              {/* No payroll data warning */}
              {!hasPayrollData && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 text-sm text-[var(--ff-text-secondary)] flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <strong className="text-amber-400">No payroll data found.</strong>
                    <p className="mt-1">
                      Payroll tables (payroll_runs, payslips) may not exist yet or contain no data for
                      this period. All values are shown as zero. Once payroll is set up, this form will
                      populate automatically.
                    </p>
                  </div>
                </div>
              )}

              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                    EMP201 — {formatDate(data.periodStart)} to {formatDate(data.periodEnd)}
                  </h2>
                </div>

                <div className="divide-y divide-[var(--ff-border-light)]">
                  {/* Summary */}
                  <div className="px-4 py-2 bg-blue-500/5">
                    <p className="text-xs font-semibold text-blue-500 uppercase tracking-wider">Employee Summary</p>
                  </div>
                  <SummaryRow label="Number of employees" value={String(data.employeeCount)} />
                  <SummaryRow label="Total taxable remuneration" value={fmt(data.totalTaxableRemuneration)} />

                  <div className="px-4 py-2 bg-blue-500/5">
                    <p className="text-xs font-semibold text-blue-500 uppercase tracking-wider">Deductions</p>
                  </div>
                  <SummaryRow label="PAYE (Pay As You Earn)" value={fmt(data.totalPAYE)} />
                  <SummaryRow label="UIF — Employee contribution" value={fmt(data.totalUIF_employee)} />
                  <SummaryRow label="UIF — Employer contribution" value={fmt(data.totalUIF_employer)} />
                  <SummaryRow label="Total UIF" value={fmt(data.totalUIF)} bold />
                  <SummaryRow label="SDL (Skills Development Levy)" value={fmt(data.totalSDL)} />

                  <div className="px-4 py-2 bg-[var(--ff-bg-primary)]">
                    <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Total Payable</p>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between bg-[var(--ff-bg-primary)]/50">
                    <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
                      Total payable to SARS
                    </span>
                    <span className="text-lg font-bold text-red-400">
                      {fmt(data.totalDeductions)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Payroll Runs Breakdown */}
              {hasPayrollData && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                  <button
                    onClick={() => setShowRuns(!showRuns)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-[var(--ff-bg-primary)]/30"
                  >
                    <span className="text-sm font-medium text-[var(--ff-text-primary)]">
                      Payroll Runs ({data.payrollRuns.length})
                    </span>
                    {showRuns ? (
                      <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                    )}
                  </button>
                  {showRuns && (
                    <div className="border-t border-[var(--ff-border-light)]">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                            <th className="px-4 py-2">Run Date</th>
                            <th className="px-4 py-2 text-right">Employees</th>
                            <th className="px-4 py-2 text-right">Gross Pay</th>
                            <th className="px-4 py-2 text-right">PAYE</th>
                            <th className="px-4 py-2 text-right">UIF</th>
                            <th className="px-4 py-2 text-right">SDL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.payrollRuns.map((run) => (
                            <tr key={run.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                              <td className="px-4 py-2 text-[var(--ff-text-primary)]">{formatDate(run.runDate)}</td>
                              <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{run.employeeCount}</td>
                              <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(run.grossPay)}</td>
                              <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(run.paye)}</td>
                              <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(run.uif)}</td>
                              <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(run.sdl)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={saveDraft}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save Draft
                </button>
                {savedId && (
                  <button
                    onClick={() => setShowSubmitModal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
                  >
                    <Send className="h-4 w-4" /> Mark as Submitted
                  </button>
                )}
              </div>
            </>
          )}

          {/* Submit Modal */}
          {showSubmitModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 w-full max-w-md mx-4">
                <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">
                  Mark as Submitted to SARS
                </h3>
                <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                  Enter the SARS eFiling reference number after submitting the EMP201 on the SARS eFiling portal.
                </p>
                <input
                  type="text"
                  value={sarsRef}
                  onChange={(e) => setSarsRef(e.target.value)}
                  placeholder="SARS reference number"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm mb-4"
                />
                <div className="flex items-center gap-3 justify-end">
                  <button
                    onClick={() => setShowSubmitModal(false)}
                    className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={markSubmitted}
                    disabled={submitting || !sarsRef.trim()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function SummaryRow({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className={`px-4 py-3 flex items-center justify-between ${bold ? 'bg-[var(--ff-bg-primary)]/30' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {label}
      </span>
      <span className={`text-sm font-medium ${bold ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {value}
      </span>
    </div>
  );
}
