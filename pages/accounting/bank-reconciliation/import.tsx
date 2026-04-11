/**
 * Bank Statement Import Page — file-first smart flow.
 *
 * 1. User drops/picks a file
 * 2. POST /bank-transactions-import-preview → returns detected bank,
 *    matched account, date range, new/duplicate counts, rule match count
 * 3. Review panel:
 *      - matched account + masked number
 *      - detected bank
 *      - date range
 *      - "X new transactions, Y duplicates will be skipped"
 *      - "Apply N matching bank rules on import" toggle
 *      - warnings (no-match, CSV-needs-account-pick, etc.)
 * 4. User confirms → POST /bank-transactions-import → result
 *
 * Edge cases handled:
 *   - CSV/OFX/QIF files have no account # → prompt user to pick one,
 *     then re-preview with the selected bankAccountId.
 *   - PDF extraction finds an account # that no bank account matches →
 *     warning + "Create bank account with number X" shortcut.
 *   - All parsed rows are duplicates → "Nothing new to import" success.
 */

import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Upload, Loader2, AlertCircle, CheckCircle2,
  FileText, Landmark, Sparkles, Calendar, Hash, AlertTriangle,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

// ── Types ────────────────────────────────────────────────────────────────────

type FileType = 'csv' | 'pdf' | 'ofx' | 'qif';

type Phase = 'upload' | 'previewing' | 'review' | 'committing' | 'result';

interface PreviewResponse {
  detectedBank: string;
  extractedAccountNumber: string | null;
  matchedBankAccountId: string | null;
  matchedBankAccountName: string | null;
  matchedBankAccountNumberMasked: string | null;
  dateRange: { from: string; to: string } | null;
  totalParsed: number;
  newCount: number;
  duplicateCount: number;
  ruleMatchCount: number;
  sampleTransactions: Array<{
    date: string;
    amount: number;
    description: string;
    balance?: number;
  }>;
  warnings: string[];
}

interface ImportResponse {
  batchId: string;
  transactionCount: number;
  duplicateCount: number;
  totalParsed: number;
  appliedRules: number;
  errors: Array<{ row: number; error: string }>;
}

interface LoadedFile {
  name: string;
  fileType: FileType;
  csvContent?: string;
  pdfBase64?: string;
}

interface BankAccountOption {
  id: string;
  label: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyFile(file: File): FileType | null {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) return 'ofx';
  if (lower.endsWith('.qif')) return 'qif';
  if (lower.endsWith('.csv') || file.type === 'text/csv') return 'csv';
  return null;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve((e.target?.result as string) ?? '');
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve((e.target?.result as string) ?? '');
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function formatCurrency(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}R ${abs.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  return iso.slice(0, 10).split('-').reverse().join('/');
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BankStatementImportPage() {
  const [phase, setPhase] = useState<Phase>('upload');
  const [error, setError] = useState('');
  const [loadedFile, setLoadedFile] = useState<LoadedFile | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [applyRules, setApplyRules] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // For the CSV/OFX/QIF fallback where the file has no account number
  // and the user needs to pick one manually before the preview can resolve.
  const [manualAccountId, setManualAccountId] = useState('');
  const [bankAccountOptions, setBankAccountOptions] = useState<BankAccountOption[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Phase 1: file upload + preview ─────────────────────────────────────────
  const runPreview = useCallback(async (
    file: LoadedFile,
    withManualAccount?: string,
  ) => {
    setError('');
    setPhase('previewing');
    setPreview(null);

    try {
      const body: Record<string, unknown> = {
        fileType: file.fileType,
      };
      if (file.fileType === 'pdf') {
        body.pdfBase64 = file.pdfBase64;
      } else {
        body.csvContent = file.csvContent;
      }
      if (withManualAccount) {
        body.bankAccountId = withManualAccount;
      }

      const res = await apiFetch('/api/accounting/bank-transactions-import-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error?.message || json?.message || 'Could not preview statement');
      }
      setPreview(json.data as PreviewResponse);
      setPhase('review');

      // If the preview didn't match an account AND we haven't asked the
      // user to pick one yet, fetch the list of bank accounts so the
      // manual-pick dropdown can render in the review panel.
      if (!(json.data as PreviewResponse).matchedBankAccountId && bankAccountOptions.length === 0) {
        void loadBankAccountOptions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not preview statement');
      setPhase('upload');
    }
  }, [bankAccountOptions.length]);

  async function loadBankAccountOptions() {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts?subtype=bank');
      const json = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any[] = Array.isArray(json?.data) ? json.data : json?.data?.accounts || [];
      const options: BankAccountOption[] = data.map(a => {
        const last4 = (a.bankAccountNumber || a.bank_account_number || '').slice(-4);
        const code = a.accountCode || a.account_code || '';
        const name = a.accountName || a.account_name || '';
        return {
          id: String(a.id),
          label: `${code} — ${name}${last4 ? ` (****${last4})` : ''}`,
        };
      });
      setBankAccountOptions(options);
    } catch {
      // non-fatal — user just won't get the manual-pick dropdown
    }
  }

  async function handleFile(file: File) {
    setError('');
    const fileType = classifyFile(file);
    if (!fileType) {
      setError('Only CSV, PDF, OFX, and QIF files are supported.');
      return;
    }

    try {
      const loaded: LoadedFile = { name: file.name, fileType };
      if (fileType === 'pdf') {
        loaded.pdfBase64 = await readFileAsDataUrl(file);
      } else {
        loaded.csvContent = await readFileAsText(file);
      }
      setLoadedFile(loaded);
      void runPreview(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    }
  }

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  // ── Phase 2: commit ────────────────────────────────────────────────────────
  async function handleCommit() {
    if (!loadedFile || !preview || !preview.matchedBankAccountId) return;
    setError('');
    setPhase('committing');

    try {
      const body: Record<string, unknown> = {
        fileType: loadedFile.fileType,
        bankAccountId: preview.matchedBankAccountId,
        statementDate: preview.dateRange?.to ?? new Date().toISOString().slice(0, 10),
        applyBankRules: applyRules,
      };
      if (loadedFile.fileType === 'pdf') {
        body.pdfBase64 = loadedFile.pdfBase64;
      } else {
        body.csvContent = loadedFile.csvContent;
      }

      const res = await apiFetch('/api/accounting/bank-transactions-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error?.message || json?.message || 'Import failed');
      }
      setResult(json.data as ImportResponse);
      setPhase('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setPhase('review');
    }
  }

  // ── Reset back to upload ───────────────────────────────────────────────────
  function reset() {
    setPhase('upload');
    setPreview(null);
    setResult(null);
    setError('');
    setLoadedFile(null);
    setApplyRules(false);
    setManualAccountId('');
  }

  // ── Manual account-pick (CSV path) ─────────────────────────────────────────
  function handleManualAccountSelected(accountId: string) {
    setManualAccountId(accountId);
    if (loadedFile && accountId) void runPreview(loadedFile, accountId);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const canCommit = !!preview?.matchedBankAccountId && preview.newCount > 0;
  const needsManualAccountPick =
    phase === 'review' && preview && !preview.matchedBankAccountId &&
    !preview.extractedAccountNumber && bankAccountOptions.length > 0;
  const needsCreateAccountShortcut =
    phase === 'review' && preview && !preview.matchedBankAccountId &&
    preview.extractedAccountNumber;

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
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Upload className="h-6 w-6 text-teal-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Import Bank Statement</h1>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* ── PHASE: UPLOAD ─────────────────────────────────────────────── */}
          {phase === 'upload' && (
            <div
              className={`
                rounded-xl border-2 border-dashed p-16 text-center transition-colors
                ${isDragging
                  ? 'border-teal-500 bg-teal-500/10'
                  : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]'}
              `}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
            >
              <Sparkles className="h-12 w-12 text-teal-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-[var(--ff-text-primary)] mb-2">
                Drop your bank statement here
              </h2>
              <p className="text-sm text-[var(--ff-text-secondary)] mb-6">
                We&rsquo;ll detect the bank, match the account, and flag duplicates automatically.
              </p>
              <label
                htmlFor="bank-statement-file-input"
                className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium cursor-pointer"
              >
                <Upload className="h-4 w-4" /> Choose file
              </label>
              <input
                id="bank-statement-file-input"
                ref={fileInputRef}
                type="file"
                accept=".csv,.pdf,.ofx,.qfx,.qif"
                onChange={onFileInputChange}
                className="sr-only"
              />
              <p className="mt-4 text-xs text-[var(--ff-text-tertiary)]">
                Supports PDF, CSV, OFX/QFX, and QIF formats from ABSA, Capitec, FNB, Nedbank, Standard Bank.
              </p>
            </div>
          )}

          {/* ── PHASE: PREVIEWING ────────────────────────────────────────── */}
          {phase === 'previewing' && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-12 text-center">
              <Loader2 className="h-8 w-8 text-teal-500 animate-spin mx-auto mb-4" />
              <p className="text-[var(--ff-text-secondary)]">
                Parsing {loadedFile?.name} and detecting the bank…
              </p>
            </div>
          )}

          {/* ── PHASE: REVIEW ────────────────────────────────────────────── */}
          {phase === 'review' && preview && (
            <div className="space-y-4">
              {/* File strip */}
              <div className="flex items-center justify-between bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] px-4 py-3">
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-teal-400" />
                  <div>
                    <div className="text-sm font-medium text-[var(--ff-text-primary)]">{loadedFile?.name}</div>
                    <div className="text-xs text-[var(--ff-text-tertiary)]">
                      {preview.detectedBank.toUpperCase()} · {preview.totalParsed} rows parsed
                    </div>
                  </div>
                </div>
                <button onClick={reset} className="text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                  Choose a different file
                </button>
              </div>

              {/* Matched account — the star of the show */}
              {preview.matchedBankAccountId && preview.matchedBankAccountName ? (
                <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-4 flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-teal-400 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-teal-300">
                      Matched: {preview.matchedBankAccountName}
                    </div>
                    <div className="text-xs text-teal-400/70">
                      Account {preview.matchedBankAccountNumberMasked} ·
                      Extracted from statement: {preview.extractedAccountNumber}
                    </div>
                  </div>
                </div>
              ) : needsCreateAccountShortcut ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-amber-300">
                        No bank account matches this statement
                      </div>
                      <div className="text-xs text-amber-400/70">
                        Statement is for account <strong>{preview.extractedAccountNumber}</strong>.
                        Create a bank account with that number to continue.
                      </div>
                    </div>
                  </div>
                  <Link
                    href={`/accounting/bank-accounts?prefillNumber=${preview.extractedAccountNumber}&prefillBank=${preview.detectedBank}`}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-medium"
                  >
                    Create bank account {preview.extractedAccountNumber}
                  </Link>
                </div>
              ) : needsManualAccountPick ? (
                <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-[var(--ff-text-primary)]">
                        Which bank account is this for?
                      </div>
                      <div className="text-xs text-[var(--ff-text-secondary)]">
                        This file format does not include the account number, so we need you to pick.
                      </div>
                    </div>
                  </div>
                  <select
                    value={manualAccountId}
                    onChange={e => handleManualAccountSelected(e.target.value)}
                    className="ff-select w-full"
                  >
                    <option value="">Select bank account…</option>
                    {bankAccountOptions.map(o => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* Warnings */}
              {preview.warnings.length > 0 && preview.matchedBankAccountId && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className="text-xs text-amber-400">{w}</div>
                  ))}
                </div>
              )}

              {/* Summary stats */}
              {preview.matchedBankAccountId && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                    <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-1">
                      <Calendar className="h-3.5 w-3.5" /> Statement period
                    </div>
                    <div className="text-sm text-[var(--ff-text-primary)]">
                      {preview.dateRange ? (
                        <>{formatDate(preview.dateRange.from)} → {formatDate(preview.dateRange.to)}</>
                      ) : 'Unknown'}
                    </div>
                  </div>
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                    <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-1">
                      <Hash className="h-3.5 w-3.5" /> Transactions
                    </div>
                    <div className="text-sm text-[var(--ff-text-primary)]">
                      <span className="font-semibold text-teal-400">{preview.newCount} new</span>
                      {preview.duplicateCount > 0 && (
                        <span className="text-[var(--ff-text-tertiary)]">
                          {' · '}{preview.duplicateCount} already imported
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Bank rules toggle */}
              {preview.matchedBankAccountId && preview.ruleMatchCount > 0 && (
                <label className="flex items-center gap-3 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 cursor-pointer hover:border-teal-500/50">
                  <input
                    type="checkbox"
                    checked={applyRules}
                    onChange={e => setApplyRules(e.target.checked)}
                    className="h-4 w-4 text-teal-600 bg-transparent border-[var(--ff-border-light)] rounded focus:ring-teal-500"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-[var(--ff-text-primary)]">
                      Apply {preview.ruleMatchCount} matching bank rule{preview.ruleMatchCount !== 1 ? 's' : ''} on import
                    </div>
                    <div className="text-xs text-[var(--ff-text-secondary)]">
                      Pre-populates suggested GL accounts, suppliers, and customers. You still confirm during reconciliation.
                    </div>
                  </div>
                </label>
              )}

              {/* Sample preview */}
              {preview.matchedBankAccountId && preview.sampleTransactions.length > 0 && (
                <details className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <summary className="text-sm font-medium text-[var(--ff-text-primary)] cursor-pointer select-none">
                    Preview first {preview.sampleTransactions.length} transactions
                  </summary>
                  <table className="w-full mt-4 text-xs">
                    <thead>
                      <tr className="text-left text-[var(--ff-text-tertiary)]">
                        <th className="pb-2 pr-2">Date</th>
                        <th className="pb-2 pr-2">Description</th>
                        <th className="pb-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sampleTransactions.map((tx, i) => (
                        <tr key={i} className="text-[var(--ff-text-secondary)] border-t border-[var(--ff-border-light)]">
                          <td className="py-1 pr-2 whitespace-nowrap">{formatDate(tx.date)}</td>
                          <td className="py-1 pr-2 truncate max-w-xs">{tx.description}</td>
                          <td className={`py-1 text-right whitespace-nowrap ${tx.amount < 0 ? 'text-red-400' : 'text-teal-400'}`}>
                            {formatCurrency(tx.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={reset}
                  className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCommit}
                  disabled={!canCommit}
                  className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors text-sm font-medium"
                >
                  {preview.matchedBankAccountId && preview.newCount === 0
                    ? 'Nothing new to import'
                    : `Import ${preview.newCount} transaction${preview.newCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          )}

          {/* ── PHASE: COMMITTING ────────────────────────────────────────── */}
          {phase === 'committing' && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-12 text-center">
              <Loader2 className="h-8 w-8 text-teal-500 animate-spin mx-auto mb-4" />
              <p className="text-[var(--ff-text-secondary)]">Importing transactions…</p>
            </div>
          )}

          {/* ── PHASE: RESULT ────────────────────────────────────────────── */}
          {phase === 'result' && result && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-teal-500/10 border border-teal-500/30 space-y-2">
                <div className="flex items-center gap-2 text-teal-400 font-medium">
                  <CheckCircle2 className="h-5 w-5" /> Import Successful
                </div>
                <ul className="text-sm text-[var(--ff-text-secondary)] space-y-1">
                  <li>✓ Imported <strong className="text-teal-400">{result.transactionCount}</strong> new transaction{result.transactionCount !== 1 ? 's' : ''}</li>
                  {result.duplicateCount > 0 && (
                    <li>• Skipped {result.duplicateCount} duplicate{result.duplicateCount !== 1 ? 's' : ''} already in the system</li>
                  )}
                  {result.appliedRules > 0 && (
                    <li>• Auto-categorised {result.appliedRules} transaction{result.appliedRules !== 1 ? 's' : ''} via bank rules</li>
                  )}
                </ul>
                {result.errors.length > 0 && (
                  <div className="text-sm text-amber-400">
                    {result.errors.length} row{result.errors.length !== 1 ? 's' : ''} skipped due to errors:
                    <ul className="list-disc ml-5 mt-1 text-xs">
                      {result.errors.slice(0, 5).map((e, i) => (
                        <li key={i}>Row {e.row}: {e.error}</li>
                      ))}
                      {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
                    </ul>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <Link
                  href="/accounting/bank-reconciliation"
                  className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
                >
                  Start a reconciliation
                </Link>
                <button
                  onClick={reset}
                  className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                >
                  Import another statement
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
