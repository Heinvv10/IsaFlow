/**
 * Payroll parallel-run comparison (Dotbiz Workstream C).
 * Route: /payroll/parallel-run
 *
 * Import an external (Sage/VIP) payslip CSV for a period, compare it to the
 * IsaFlow payroll run for the same period — per employee, per component, to
 * the cent — and export the result as CSV.
 */
import { useCallback, useEffect, useState } from 'react';
import { GitCompareArrows, Loader2, AlertCircle, Download, Trash2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { ParallelRunUploadCard } from '@/components/payroll/parallelRun/ParallelRunUploadCard';
import { ParallelRunReportView } from '@/components/payroll/parallelRun/ParallelRunReportView';
import type { ParallelRunComparisonReport } from '@/modules/accounting/services/payroll/payrollParallelRunTypes';

interface ImportSummary {
  id: string;
  periodMonth: number;
  periodYear: number;
  source: string;
  fileName: string | null;
  payslipCount: number;
  createdAt: string;
}

interface ReportPayload {
  import: ImportSummary;
  run: { id: string; status: string } | null;
  comparison: ParallelRunComparisonReport | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodLabel = (m: number, y: number) => `${MONTHS[m - 1] ?? m} ${y}`;

export default function ParallelRunPage() {
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [rowWarnings, setRowWarnings] = useState<Array<{ line: number; message: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isComparing, setIsComparing] = useState(false);
  const [error, setError] = useState('');

  const loadImports = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/payroll/parallel-run/imports');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: { imports?: ImportSummary[] } };
      setImports(json.data?.imports ?? []);
    } catch {
      setError('Failed to load imports');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadImports(); }, [loadImports]);

  const loadComparison = useCallback(async (importId: string) => {
    setIsComparing(true);
    setError('');
    setReport(null);
    try {
      const res = await apiFetch(`/api/payroll/parallel-run/compare?importId=${importId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: ReportPayload };
      setReport(json.data ?? null);
    } catch {
      setError('Failed to load comparison');
    } finally {
      setIsComparing(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadComparison(selectedId);
  }, [selectedId, loadComparison]);

  const handleImported = (importId: string, errors: Array<{ line: number; message: string }>) => {
    setRowWarnings(errors);
    setSelectedId(importId);
    loadImports();
  };

  const handleDelete = async (importId: string) => {
    const imp = imports.find((i) => i.id === importId);
    const label = imp ? `${periodLabel(imp.periodMonth, imp.periodYear)} (${imp.payslipCount} payslips)` : 'this import';
    if (!window.confirm(`Delete the ${label} import? This cannot be undone.`)) return;
    const res = await apiFetch(`/api/payroll/parallel-run/imports/${importId}`, { method: 'DELETE' });
    if (res.ok) {
      if (selectedId === importId) { setSelectedId(null); setReport(null); }
      loadImports();
    } else {
      setError('Failed to delete import');
    }
  };

  const handleExport = async (importId: string) => {
    setError('');
    const res = await apiFetch(`/api/payroll/parallel-run/export?importId=${importId}`);
    if (!res.ok) { setError('Export failed'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const imp = imports.find((i) => i.id === importId);
    a.download = imp ? `parallel-run_${imp.periodYear}-${String(imp.periodMonth).padStart(2, '0')}.csv` : 'parallel-run.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <GitCompareArrows className="h-5 w-5 text-teal-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Parallel Run Comparison</h1>
            <p className="text-xs text-[var(--ff-text-tertiary)]">
              IsaFlow payroll vs your current payroll system, to the cent
            </p>
          </div>
        </div>

        <ParallelRunUploadCard onImported={handleImported} />

        {rowWarnings.length > 0 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-400">
            <p className="font-medium mb-1">{rowWarnings.length} row(s) were skipped:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {rowWarnings.slice(0, 10).map((w) => <li key={`${w.line}-${w.message}`}>Line {w.line}: {w.message}</li>)}
              {rowWarnings.length > 10 && <li>… and {rowWarnings.length - 10} more</li>}
            </ul>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border)]">
                <th className="px-4 py-2">Period</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">File</th>
                <th className="px-4 py-2 text-right">Payslips</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={5} className="px-4 py-6 text-center">
                  <Loader2 className="h-5 w-5 animate-spin inline text-[var(--ff-text-tertiary)]" />
                </td></tr>
              )}
              {!isLoading && imports.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--ff-text-tertiary)]">
                  No imports yet — upload an external payslip CSV to start a parallel run.
                </td></tr>
              )}
              {!isLoading && imports.map((imp) => (
                <tr
                  key={imp.id}
                  onClick={() => setSelectedId(imp.id)}
                  className={`border-b border-[var(--ff-border)] last:border-0 cursor-pointer hover:bg-[var(--ff-bg-tertiary)] ${
                    selectedId === imp.id ? 'bg-[var(--ff-bg-tertiary)]' : ''
                  }`}
                >
                  <td className="px-4 py-2 font-medium text-[var(--ff-text-primary)]">
                    {periodLabel(imp.periodMonth, imp.periodYear)}
                  </td>
                  <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{imp.source}</td>
                  <td className="px-4 py-2 text-[var(--ff-text-tertiary)]">{imp.fileName ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{imp.payslipCount}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleExport(imp.id); }}
                      title="Export comparison CSV"
                      className="p-1.5 rounded-lg text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)]"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(imp.id); }}
                      title="Delete import"
                      className="p-1.5 rounded-lg text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-[var(--ff-bg-primary)]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {isComparing && (
          <div className="flex items-center gap-2 text-sm text-[var(--ff-text-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Comparing…
          </div>
        )}
        {report && !report.comparison && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
            No IsaFlow payroll run exists for {periodLabel(report.import.periodMonth, report.import.periodYear)} yet —
            calculate the run first, then re-open this comparison.
          </div>
        )}
        {report?.comparison && <ParallelRunReportView report={report.comparison} />}
      </div>
    </AppLayout>
  );
}
