/**
 * IRP5 Readiness Dashboard.
 * Route: /payroll/irp5
 */
import { useEffect, useState, useCallback } from 'react';
import { FileText, Loader2, AlertCircle, Download, AlertTriangle, Info } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';

type Severity = 'error' | 'warning' | 'info';
interface ValidationMessage {
  severity: Severity;
  code: string;
  message: string;
  field?: string;
}

interface Irp5Employee {
  employeeId: string;
  firstName: string;
  lastName: string;
  idNumber: string | null;
  taxNumber: string | null;
  startDate: string;
  endDate: string | null;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  status: 'ready' | 'incomplete' | 'missing';
  messages: ValidationMessage[];
}

interface Irp5Summary {
  taxYear: number;
  totalEmployees: number;
  certificatesReady: number;
  incomplete: number;
  missing: number;
  totalPayeSubmitted: number;
  componentIssues: ValidationMessage[];
  employees: Irp5Employee[];
}

const SEVERITY_STYLES: Record<Severity, string> = {
  error: 'bg-red-500/10 text-red-300 border-red-500/30',
  warning: 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30',
  info: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
};

const STATUS_STYLES: Record<string, string> = {
  ready: 'bg-teal-500/10 text-teal-400',
  incomplete: 'bg-yellow-500/10 text-yellow-400',
  missing: 'bg-red-500/10 text-red-400',
};

function SummaryCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4">
      <p className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{value}</p>
      {sub && <p className="text-xs text-[var(--ff-text-secondary)] mt-1">{sub}</p>}
    </div>
  );
}

function buildCsv(employees: Irp5Employee[]): string {
  const headers = 'Employee Name,ID/Passport,Tax Number,Start Date,End Date,Gross Income,PAYE,UIF,SDL,Status';
  const rows = employees.map(e =>
    [
      `${e.firstName} ${e.lastName}`,
      e.idNumber ?? '',
      e.taxNumber ?? '',
      e.startDate,
      e.endDate ?? '',
      e.totalGross.toFixed(2),
      e.totalPaye.toFixed(2),
      e.totalUif.toFixed(2),
      e.totalSdl.toFixed(2),
      e.status,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  );
  return [headers, ...rows].join('\n');
}

export default function Irp5Page() {
  const currentTaxYear = new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const [taxYear, setTaxYear] = useState(currentTaxYear + 1); // e.g., 2026 = Mar2025–Feb2026
  const [summary, setSummary] = useState<Irp5Summary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/irp5/summary?taxYear=${taxYear}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: Irp5Summary };
      setSummary((json.data ?? null) as Irp5Summary | null);
    } catch {
      setError('Failed to load IRP5 summary');
    } finally {
      setIsLoading(false);
    }
  }, [taxYear]);

  useEffect(() => { void load(); }, [load]);

  const handleExport = () => {
    if (!summary) return;
    const csv = buildCsv(summary.employees);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `IRP5_${taxYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [easyFileError, setEasyFileError] = useState<string | null>(null);
  const handleEasyFileExport = async () => {
    setEasyFileError(null);
    try {
      const res = await apiFetch(`/api/payroll/irp5/easyfile-export?taxYear=${taxYear}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string; details?: { missing?: string[]; fix?: string } } } | null;
        const msg = json?.error?.message ?? `HTTP ${res.status}`;
        const missing = json?.error?.details?.missing;
        const fix = json?.error?.details?.fix;
        setEasyFileError([msg, missing ? `Missing: ${missing.join(', ')}` : '', fix ? `Fix here: ${fix}` : ''].filter(Boolean).join(' · '));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `IRP5_${taxYear - 1}_${taxYear}.irp5`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setEasyFileError(err instanceof Error ? err.message : 'e@syFile export failed');
    }
  };

  const taxYearLabel = (y: number) => `${y - 1}/${y} (Mar ${y - 1} – Feb ${y})`;
  const yearOptions = [currentTaxYear, currentTaxYear + 1, currentTaxYear + 2];

  const flagged = summary?.employees.filter(e => e.messages.some(m => m.severity !== 'info')) ?? [];
  const componentIssues = summary?.componentIssues ?? [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileText className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">IRP5 Readiness</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Tax certificate preparation dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={taxYear}
                onChange={e => setTaxYear(Number(e.target.value))}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
              >
                {yearOptions.map(y => <option key={y} value={y}>{taxYearLabel(y)}</option>)}
              </select>
              <button
                onClick={handleExport}
                disabled={!summary || summary.employees.length === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <button
                onClick={() => void handleEasyFileExport()}
                disabled={!summary || summary.employees.length === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-sm text-white font-medium disabled:opacity-50"
                title="SARS e@syFile IRP5 import file (BRS v25.2)"
              >
                <Download className="h-4 w-4" /> e@syFile IRP5
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {easyFileError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 text-sm text-red-300 px-3 py-2 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{easyFileError}</span>
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-4"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
          ) : summary && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <SummaryCard label="Total Employees" value={summary.totalEmployees} />
                <SummaryCard label="Certificates Ready" value={summary.certificatesReady} sub="Complete records" />
                <SummaryCard label="Incomplete" value={summary.incomplete} sub="Missing data" />
                <SummaryCard label="Total PAYE" value={formatCurrency(summary.totalPayeSubmitted)} sub="Tax year total" />
              </div>

              {/* Company-wide component issues (duplicate code across components, etc.) */}
              {componentIssues.length > 0 && (
                <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Info className="h-4 w-4 text-[var(--ff-text-secondary)]" />
                    <span className="text-sm font-medium text-[var(--ff-text-primary)]">Payroll component configuration</span>
                  </div>
                  <ul className="space-y-2">
                    {componentIssues.map((m, i) => (
                      <li key={i} className={`text-xs rounded border px-2 py-1.5 ${SEVERITY_STYLES[m.severity]}`}>
                        {m.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Employee flags */}
              {flagged.length > 0 && (
                <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="h-4 w-4 text-yellow-400" />
                    <span className="text-sm font-medium text-yellow-400">
                      {flagged.length} employee{flagged.length !== 1 ? 's' : ''} with issues
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {flagged.map(e => (
                      <li key={e.employeeId} className="text-sm text-[var(--ff-text-secondary)]">
                        <span className="font-medium text-[var(--ff-text-primary)]">{e.firstName} {e.lastName}</span>
                        <ul className="mt-1 ml-4 space-y-1">
                          {e.messages.filter(m => m.severity !== 'info').map((m, i) => (
                            <li key={i} className={`inline-block mr-2 text-xs rounded border px-2 py-0.5 ${SEVERITY_STYLES[m.severity]}`}>
                              {m.message}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Employee table */}
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employee</th>
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">ID / Passport</th>
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Tax Number</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Gross</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">PAYE</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF</th>
                      <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">SDL</th>
                      <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.employees.map(e => (
                      <tr key={e.employeeId} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                        <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">{e.firstName} {e.lastName}</td>
                        <td className="py-3 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{e.idNumber ?? <span className="text-red-400">missing</span>}</td>
                        <td className="py-3 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{e.taxNumber ?? <span className="text-red-400">missing</span>}</td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatCurrency(e.totalGross)}</td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatCurrency(e.totalPaye)}</td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{formatCurrency(e.totalUif)}</td>
                        <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{formatCurrency(e.totalSdl)}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLES[e.status]}`}>{e.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
