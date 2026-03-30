/**
 * GL Import Wizard — Steps 3 & 4 components.
 * Separated to keep page file within reasonable size.
 */

import { ArrowLeft, ArrowRight, CheckCircle2, XCircle, AlertTriangle, Upload, Loader2 } from 'lucide-react';
import type { ValidationSummary, ImportRow } from '@/modules/accounting/services/glImportService';

// ---- Step 3: Validation Results ---------------------------------------------

interface Step3Props {
  summary: ValidationSummary;
  onBack: () => void;
  onNext: () => void;
}

export function ValidationStep({ summary, onBack, onNext }: Step3Props) {
  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Rows', value: summary.validations.length, color: 'text-[var(--ff-text-primary)]' },
          { label: 'Valid', value: summary.validCount, color: 'text-green-400' },
          { label: 'Warnings', value: summary.warningCount, color: 'text-amber-400' },
          { label: 'Errors', value: summary.errorCount, color: 'text-red-400' },
        ].map(c => (
          <div key={c.label} className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 text-center">
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
            <div className="text-xs text-[var(--ff-text-secondary)] mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Balance check */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
        summary.isBalanced
          ? 'bg-green-500/10 border-green-500/20 text-green-400'
          : 'bg-red-500/10 border-red-500/20 text-red-400'
      }`}>
        {summary.isBalanced
          ? <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
          : <XCircle className="h-5 w-5 flex-shrink-0" />}
        <span className="text-sm font-medium">
          {summary.isBalanced
            ? `Balanced — Debit: R${summary.totalDebit.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} / Credit: R${summary.totalCredit.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`
            : `Out of balance — Debit: R${summary.totalDebit.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} / Credit: R${summary.totalCredit.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} (difference: R${Math.abs(summary.totalDebit - summary.totalCredit).toLocaleString('en-ZA', { minimumFractionDigits: 2 })})`}
        </span>
      </div>

      {/* Error / warning table */}
      {summary.validations.some(v => !v.valid || v.warnings.length > 0) && (
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
            <span className="text-sm font-medium text-[var(--ff-text-primary)]">Row-level issues</span>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--ff-bg-secondary)]">
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="text-left px-4 py-2 text-[var(--ff-text-secondary)] font-medium">Row</th>
                  <th className="text-left px-4 py-2 text-[var(--ff-text-secondary)] font-medium">Type</th>
                  <th className="text-left px-4 py-2 text-[var(--ff-text-secondary)] font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {summary.validations.flatMap(v => [
                  ...v.errors.map((e, i) => ({ row: v.row, type: 'error', msg: e, key: `e-${v.row}-${i}` })),
                  ...v.warnings.map((w, i) => ({ row: v.row, type: 'warning', msg: w, key: `w-${v.row}-${i}` })),
                ]).map(item => (
                  <tr key={item.key} className="border-b border-[var(--ff-border-light)]/50">
                    <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{item.row}</td>
                    <td className="px-4 py-2">
                      {item.type === 'error'
                        ? <span className="inline-flex items-center gap-1 text-red-400"><XCircle className="h-3 w-3" />Error</span>
                        : <span className="inline-flex items-center gap-1 text-amber-400"><AlertTriangle className="h-3 w-3" />Warning</span>}
                    </td>
                    <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{item.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-secondary)] transition-colors text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          disabled={summary.validCount === 0}
          onClick={onNext}
          className="inline-flex items-center gap-2 px-5 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
        >
          <ArrowRight className="h-4 w-4" />
          Continue ({summary.validCount} valid rows)
        </button>
      </div>
    </div>
  );
}

// ---- Step 4: Import ---------------------------------------------------------

interface ImportResult {
  entriesCreated: number;
  linesCreated: number;
  totalValue: number;
}

interface Step4Props {
  validRows: ImportRow[];
  summary: ValidationSummary;
  postImmediately: boolean;
  onPostModeChange: (v: boolean) => void;
  onBack: () => void;
  onImport: () => void;
  importing: boolean;
  importError: string;
  importResult: ImportResult | null;
  onViewEntries: () => void;
  onReset: () => void;
}

export function ImportStep({
  validRows, summary, postImmediately, onPostModeChange,
  onBack, onImport, importing, importError, importResult,
  onViewEntries, onReset,
}: Step4Props) {
  if (importResult) {
    return (
      <div className="text-center py-12 space-y-6">
        <div className="flex items-center justify-center">
          <div className="p-4 rounded-full bg-green-500/10">
            <CheckCircle2 className="h-12 w-12 text-green-400" />
          </div>
        </div>
        <div>
          <h2 className="text-xl font-bold text-[var(--ff-text-primary)] mb-2">Import Successful</h2>
          <p className="text-[var(--ff-text-secondary)]">
            {importResult.entriesCreated} journal {importResult.entriesCreated === 1 ? 'entry' : 'entries'} created
            with {importResult.linesCreated} lines
            totalling R{importResult.totalValue.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}.
          </p>
        </div>
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={onViewEntries}
            className="inline-flex items-center gap-2 px-5 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
          >
            View Journal Entries
          </button>
          <button
            onClick={onReset}
            className="inline-flex items-center gap-2 px-5 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-secondary)] transition-colors text-sm"
          >
            Import Another File
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-6 space-y-4">
        <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Import Summary</h2>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-[var(--ff-text-primary)]">{validRows.length}</div>
            <div className="text-xs text-[var(--ff-text-secondary)]">Lines to import</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-teal-400">
              R{summary.totalDebit.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
            </div>
            <div className="text-xs text-[var(--ff-text-secondary)]">Total debit value</div>
          </div>
          <div>
            <div className={`text-2xl font-bold ${summary.isBalanced ? 'text-green-400' : 'text-amber-400'}`}>
              {summary.isBalanced ? 'Balanced' : 'Unbalanced'}
            </div>
            <div className="text-xs text-[var(--ff-text-secondary)]">Balance status</div>
          </div>
        </div>

        <div className="border-t border-[var(--ff-border-light)] pt-4">
          <p className="text-sm font-medium text-[var(--ff-text-primary)] mb-3">Posting option</p>
          <div className="space-y-2">
            {[
              { value: false, label: 'Import as Draft', desc: 'Entries created as drafts — review and post manually' },
              { value: true, label: 'Import and Post', desc: 'Entries immediately posted to the general ledger' },
            ].map(opt => (
              <label key={String(opt.value)} className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="postMode"
                  checked={postImmediately === opt.value}
                  onChange={() => onPostModeChange(opt.value)}
                  className="mt-0.5 accent-teal-500"
                />
                <div>
                  <span className="text-sm font-medium text-[var(--ff-text-primary)]">{opt.label}</span>
                  <p className="text-xs text-[var(--ff-text-secondary)]">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {importError && (
        <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
          <XCircle className="h-4 w-4 flex-shrink-0" />
          {importError}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-secondary)] transition-colors text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          onClick={onImport}
          disabled={importing}
          className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
        >
          {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {importing ? 'Importing...' : `Import ${validRows.length} rows`}
        </button>
      </div>
    </div>
  );
}
