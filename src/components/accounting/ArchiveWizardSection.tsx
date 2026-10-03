/**
 * Archive Wizard section for the Data Archiving page.
 * Contains the cutoff date picker, validate/preview buttons, and result displays.
 * Executing an archive is switched off (the route refuses it); the notice says why.
 */

import { AlertTriangle, CheckCircle2, XCircle, Eye, Loader2 } from 'lucide-react';
import type { ArchivePreview, ArchiveValidation } from '@/modules/accounting/services/core/dataArchivingService';

interface Props {
  cutoffDate: string;
  maxCutoff: string;
  validation: ArchiveValidation | null;
  validating: boolean;
  preview: ArchivePreview | null;
  previewing: boolean;
  onCutoffChange: (v: string) => void;
  onValidate: () => void;
  onPreview: () => void;
}

export function ArchiveWizardSection({
  cutoffDate, maxCutoff, validation, validating, preview, previewing,
  onCutoffChange, onValidate, onPreview,
}: Props) {
  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">Cutoff Date</label>
        <p className="text-xs text-[var(--ff-text-muted)] mb-2">
          Records before this date (fully finalised) will be moved to archive tables.
          Maximum allowed cutoff: <strong>{maxCutoff}</strong> (5-year minimum retention).
        </p>
        <input type="date" value={cutoffDate} max={maxCutoff}
          onChange={(e) => onCutoffChange(e.target.value)}
          className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-teal-500" />
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={onValidate} disabled={!cutoffDate || validating}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Validate
        </button>
        <button onClick={onPreview} disabled={!cutoffDate || previewing}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <p>
          Archiving is switched off. It deletes posted journals, and the reports do not read the archive,
          so every trial balance, balance sheet and VAT return before the cutoff would change.
          Validate and Preview still show what an archive would cover.
        </p>
      </div>

      {validation && (
        <div className={`rounded-lg border p-4 ${validation.valid ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}`}>
          <div className="flex items-center gap-2 mb-2">
            {validation.valid ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <XCircle className="h-5 w-5 text-red-600" />}
            <span className={`text-sm font-semibold ${validation.valid ? 'text-green-800' : 'text-red-800'}`}>
              {validation.valid ? 'Validation Passed' : 'Validation Failed'}
            </span>
          </div>
          {validation.errors.length > 0 && (
            <ul className="list-disc list-inside space-y-1">
              {validation.errors.map((e, i) => <li key={i} className="text-sm text-red-700">{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <div className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] p-4">
          <p className="text-sm font-semibold text-[var(--ff-text-primary)] mb-3">Records that would be archived before {cutoffDate}:</p>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Journal Entries', value: preview.journalEntries },
              { label: 'Journal Lines', value: preview.journalLines },
              { label: 'Bank Transactions', value: preview.bankTransactions },
              { label: 'Customer Invoices', value: preview.customerInvoices },
              { label: 'Supplier Invoices', value: preview.supplierInvoices },
            ].map((item) => (
              <div key={item.label} className="rounded-lg bg-[var(--ff-bg-secondary)] p-3">
                <dt className="text-xs text-[var(--ff-text-muted)]">{item.label}</dt>
                <dd className="text-lg font-bold text-[var(--ff-text-primary)]">{item.value.toLocaleString()}</dd>
              </div>
            ))}
            <div className="rounded-lg bg-teal-50 border border-teal-200 p-3">
              <dt className="text-xs text-teal-700 font-medium">Total Records</dt>
              <dd className="text-lg font-bold text-teal-800">{preview.totalRecords.toLocaleString()}</dd>
            </div>
          </dl>
          {preview.customerInvoicesSkipped > 0 && (
            <p className="mt-3 text-xs text-[var(--ff-text-muted)]">
              {preview.customerInvoicesSkipped.toLocaleString()} paid or cancelled customer invoice(s) before the cutoff cannot
              be archived: a Paystack or Stitch payment request refers to them. If one of them is still linked to a journal
              before the cutoff, the whole archive is refused; Validate checks this.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
