/**
 * Bank Statement Import Page
 * PRD-060 Phase 4: CSV + PDF upload with format detection
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Upload, Loader2, AlertCircle, CheckCircle2, Landmark, FileText } from 'lucide-react';

interface BankAccount { id: string; account_code: string; account_name: string; bank_account_number?: string | null }

type FileType = 'csv' | 'pdf' | 'ofx' | 'qif';

interface ImportForm {
  bankAccountId: string;
  statementDate: string;
  bankFormat: string;
  /** Raw text content for CSV files */
  csvContent: string;
  /** Base64 data-URL for PDF files */
  pdfBase64: string;
  fileName: string;
  fileType: FileType | '';
}

export default function BankStatementImportPage() {
  useRouter();
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    batchId: string;
    transactionCount: number;
    errors: { row: number; error: string }[];
  } | null>(null);

  const [form, setForm] = useState<ImportForm>({
    bankAccountId: '',
    statementDate: new Date().toISOString().split('T')[0]!,
    bankFormat: 'auto',
    csvContent: '',
    pdfBase64: '',
    fileName: '',
    fileType: '',
  });

  useEffect(() => {
    fetch('/api/accounting/chart-of-accounts?subtype=bank')
      .then(r => r.json())
      .then(res => {
        const data = res.data || res;
        const accounts = Array.isArray(data) ? data : data.accounts || [];
        setBankAccounts(
          accounts.map((a: {
            id: string;
            accountCode?: string;
            account_code?: string;
            accountName?: string;
            account_name?: string;
            bankAccountNumber?: string;
            bank_account_number?: string;
          }) => ({
            id: a.id,
            account_code: a.accountCode || a.account_code || '',
            account_name: a.accountName || a.account_name || '',
            bank_account_number: a.bankAccountNumber || a.bank_account_number || null,
          })),
        );
      });
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
    const isCsv = lower.endsWith('.csv') || file.type === 'text/csv';
    const isOfx = lower.endsWith('.ofx') || lower.endsWith('.qfx');
    const isQif = lower.endsWith('.qif');

    if (!isPdf && !isCsv && !isOfx && !isQif) {
      setError('Only CSV, PDF, OFX, and QIF files are supported.');
      return;
    }

    setError('');

    if (isPdf) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setForm(f => ({
          ...f,
          pdfBase64: ev.target?.result as string || '',
          csvContent: '',
          fileName: file.name,
          fileType: 'pdf',
        }));
      };
      reader.readAsDataURL(file);
    } else {
      // CSV, OFX, and QIF are all read as text
      const detectedFileType: FileType = isOfx ? 'ofx' : isQif ? 'qif' : 'csv';
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string || '';
        setForm(f => ({
          ...f,
          csvContent: content,
          pdfBase64: '',
          fileName: file.name,
          fileType: detectedFileType,
          // Auto-set bankFormat for OFX/QIF since format is unambiguous
          bankFormat: isOfx ? 'ofx' : isQif ? 'qif' : f.bankFormat,
        }));
      };
      reader.readAsText(file);
    }
  };

  const hasFile = form.fileType === 'pdf' ? !!form.pdfBase64 : !!form.csvContent;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setIsSubmitting(true);

    try {
      const body: Record<string, unknown> = {
        bankAccountId: form.bankAccountId,
        statementDate: form.statementDate,
        bankFormat: form.bankFormat === 'auto' ? undefined : form.bankFormat,
        fileType: form.fileType || 'csv',
      };

      if (form.fileType === 'pdf') {
        body.pdfBase64 = form.pdfBase64;
      } else {
        // csv, ofx, and qif all send csvContent (raw text)
        body.csvContent = form.csvContent;
      }

      const res = await fetch('/api/accounting/bank-transactions-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Import failed');
      setResult(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const csvRowCount = form.fileType === 'csv' ? Math.max(0, form.csvContent.split('\n').length - 1) : 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link
              href="/accounting/bank-reconciliation"
              className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Reconciliations
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Upload className="h-6 w-6 text-emerald-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Import Bank Statement</h1>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {result && (
            <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-medium">
                <CheckCircle2 className="h-5 w-5" /> Import Successful
              </div>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Imported {result.transactionCount} transaction{result.transactionCount !== 1 ? 's' : ''}
              </p>
              {result.errors.length > 0 && (
                <div className="text-sm text-amber-400">
                  {result.errors.length} row{result.errors.length !== 1 ? 's' : ''} skipped:
                  <ul className="list-disc ml-5 mt-1 text-xs">
                    {result.errors.slice(0, 5).map((e, i) => (
                      <li key={i}>Row {e.row}: {e.error}</li>
                    ))}
                    {result.errors.length > 5 && <li>...and {result.errors.length - 5} more</li>}
                  </ul>
                </div>
              )}
              <div className="pt-2">
                <Link
                  href="/accounting/bank-reconciliation"
                  className="text-sm text-emerald-500 hover:text-emerald-400 font-medium"
                >
                  Start a reconciliation with these transactions
                </Link>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Statement Details</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                    Bank Account *
                  </label>
                  <select
                    value={form.bankAccountId}
                    onChange={e => setForm(f => ({ ...f, bankAccountId: e.target.value }))}
                    className="ff-select w-full"
                    required
                  >
                    <option value="">Select bank account...</option>
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.account_code} — {a.account_name}
                        {a.bank_account_number ? ` (****${a.bank_account_number.slice(-4)})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                    Statement Date *
                  </label>
                  <input
                    type="date"
                    value={form.statementDate}
                    onChange={e => setForm(f => ({ ...f, statementDate: e.target.value }))}
                    className="ff-input w-full"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                    Bank Format
                  </label>
                  <select
                    value={form.bankFormat}
                    onChange={e => setForm(f => ({ ...f, bankFormat: e.target.value }))}
                    className="ff-select w-full"
                  >
                    <option value="auto">Auto-detect</option>
                    <optgroup label="CSV Formats">
                      <option value="absa">ABSA</option>
                      <option value="capitec">Capitec</option>
                      <option value="fnb">FNB</option>
                      <option value="standard_bank">Standard Bank</option>
                      <option value="nedbank">Nedbank</option>
                    </optgroup>
                    <optgroup label="Other Formats">
                      <option value="ofx">OFX / QFX (Open Financial Exchange)</option>
                      <option value="qif">QIF (Quicken Interchange Format)</option>
                    </optgroup>
                  </select>
                </div>
              </div>
            </div>

            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Statement File</h2>

              <div className="border-2 border-dashed border-[var(--ff-border-light)] rounded-lg p-8 text-center">
                {form.fileType === 'pdf' ? (
                  <FileText className="h-8 w-8 text-red-400 mx-auto mb-3" />
                ) : (
                  <Landmark className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
                )}
                <label className="block">
                  <span className="text-emerald-500 hover:text-emerald-400 cursor-pointer font-medium">
                    Choose CSV, PDF, OFX, or QIF file
                  </span>
                  <input
                    type="file"
                    accept=".csv,.pdf,.ofx,.qfx,.qif"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
                {form.fileName ? (
                  <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
                    {form.fileName}
                    {form.fileType && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] uppercase">
                        {form.fileType}
                      </span>
                    )}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">
                  Supports CSV (ABSA, Capitec, FNB, Standard Bank, Nedbank), PDF, OFX/QFX, and QIF formats
                </p>
              </div>

              {form.fileType === 'csv' && form.csvContent && (
                <div className="text-sm text-[var(--ff-text-secondary)]">
                  {csvRowCount} data row{csvRowCount !== 1 ? 's' : ''} detected
                </div>
              )}

              {form.fileType === 'ofx' && form.csvContent && (
                <div className="text-sm text-[var(--ff-text-secondary)]">
                  OFX file loaded — transactions will be extracted on import
                </div>
              )}

              {form.fileType === 'qif' && form.csvContent && (
                <div className="text-sm text-[var(--ff-text-secondary)]">
                  QIF file loaded — transactions will be extracted on import
                </div>
              )}

              {form.fileType === 'pdf' && form.pdfBase64 && (
                <div className="text-sm text-[var(--ff-text-secondary)]">
                  PDF loaded — transactions will be extracted on import
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <Link
                href="/accounting/bank-reconciliation"
                className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={isSubmitting || !hasFile || !form.bankAccountId}
                className="inline-flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Import Statement
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
