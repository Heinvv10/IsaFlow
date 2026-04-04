/**
 * Archive Wizard section for the Data Archiving page.
 * Contains the cutoff date picker, validate/preview/archive buttons, and result displays.
 */

import { Archive, CheckCircle2, XCircle, Eye, Loader2 } from 'lucide-react';
import type { ArchivePreview, ArchiveValidation } from '@/modules/accounting/services/dataArchivingService';

interface Props {
  cutoffDate: string;
  maxCutoff: string;
  validation: ArchiveValidation | null;
  validating: boolean;
  preview: ArchivePreview | null;
  previewing: boolean;
  archiving: boolean;
  archiveError: string | null;
  archiveSuccess: boolean;
  onCutoffChange: (v: string) => void;
  onValidate: () => void;
  onPreview: () => void;
  onRequestArchive: () => void;
}

export function ArchiveWizardSection({
  cutoffDate, maxCutoff, validation, validating, preview, previewing,
  archiving, archiveError, archiveSuccess, onCutoffChange, onValidate, onPreview, onRequestArchive,
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
        <button onClick={onRequestArchive} disabled={!validation?.valid || archiving}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {archiving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />} Archive Now
        </button>
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
        </div>
      )}

      {archiveSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800">
          <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
          Archive completed successfully. Data has been moved to archive tables.
        </div>
      )}
      {archiveError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          {archiveError}
        </div>
      )}
    </div>
  );
}
