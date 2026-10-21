import { useState, useRef, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch, apiJson, assertOk, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { parseAmount } from '@/lib/parseAmount';
import { parseMigrationCsv } from '@/components/accounting/migration/parseMigrationCsv';
import { TemplateDownloadCard } from '@/components/accounting/migration/TemplateDownloadCard';
import { RowProblemsList } from '@/components/accounting/migration/RowProblemsList';
import {
  parseOpeningBalanceCsv,
  type OpeningBalanceCsvRow as BalanceRow,
} from '@/modules/accounting/services/core/openingBalanceCsv';

/**
 * What importOpeningBalances returns. The page used to read `balancesSet` and
 * `journalId` — fields the service never returned — so the success message
 * read "set for undefined accounts", and the per-row errors were never shown.
 */
interface ImportResult {
  journalEntryId: string;
  linesImported?: number;
  errors?: Array<{ row?: number; message: string }>;
}

export default function OpeningBalancesPage() {
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  const difference = Math.abs(totalDebit - totalCredit);
  const isBalanced = difference < 0.01;

  const handleFile = async (file: File) => {
    setError('');
    setImportResult(null);
    setRows([]);
    setRowErrors([]);
    let csv;
    try {
      csv = await parseMigrationCsv(file);
    } catch (err) {
      log.warn('CSV parse error', { error: err }, 'migration');
      setError('Could not read the CSV file - check it is a valid CSV and try again');
      return;
    }
    // Headers matched ignoring case / spaces / underscores, with the aliases
    // real exports use; a file without them is told what was expected.
    const result = parseOpeningBalanceCsv(csv.data, csv.fields);
    if (result.missingColumnsMessage) { setError(result.missingColumnsMessage); return; }
    setRowErrors(result.errors.map(e => e.message));
    setRows(result.rows);
    if (result.rows.length === 0 && result.errors.length === 0) setError('The file has no balance rows');
  };

  const updateRow = useCallback((i: number, field: 'debit' | 'credit', val: string) => {
    const n = parseAmount(val);
    if (Number.isNaN(n)) return;
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: n } : r));
  }, []);

  const handleImport = async () => {
    if (!effectiveDate) { setError('Please set an effective date'); return; }
    if (rowErrors.length > 0) { setError('Some rows could not be read - fix them in the file and upload again'); return; }
    if (!isBalanced) { setError(`Trial balance is not balanced. Difference: ${difference.toFixed(2)}`); return; }
    setIsImporting(true);
    setError('');
    try {
      // The envelope is { session: {...} | null } — reading `data.id` always
      // yielded undefined, so this flow always failed with "No active session."
      const { session } = await apiJson('/api/accounting/migration/session', undefined, 'Could not load the migration session - try again');
      const sessionId = session?.id;
      if (!sessionId) throw new ApiEnvelopeError('No active migration session');

      const res = await apiFetch('/api/accounting/migration/opening-balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          effectiveDate,
          balances: rows.map(r => ({ accountCode: r.accountCode, debit: r.debit, credit: r.credit })),
        }),
      });
      await assertOk(res, 'Could not import the opening balances - try again');
      const json = await res.json();
      setImportResult(json.data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not import the opening balances - try again'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/accounting/migration" className="flex items-center gap-2 text-blue-600 hover:text-blue-800 mb-6 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Migration Hub
        </Link>
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-2">Opening Balances</h1>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-6">Upload a trial balance CSV to set opening balances.</p>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {importResult && (
          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Opening balances posted: {importResult.linesImported ?? 0} account line(s). Journal entry {importResult.journalEntryId}.
            </div>
            <RowProblemsList problems={(importResult.errors ?? []).map(e => (typeof e.row === 'number' ? `Row ${e.row + 1}: ${e.message}` : e.message))} />
          </div>
        )}

        <div className="space-y-6">
          <TemplateDownloadCard step="opening-balances" onError={setError} />

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">2. Upload Trial Balance CSV</h2>
            <p className="text-xs text-[var(--ff-text-secondary)] mb-3">Needs an account code column and either Debit / Credit columns or a single Balance column (negative = credit). Header names are matched loosely.</p>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]).catch(() => setError('Could not read the CSV file - try again')); }} />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 border-2 border-dashed border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-secondary)] hover:border-blue-500 hover:text-blue-500 text-sm transition-colors"
            >
              <Upload className="h-4 w-4" /> Choose CSV file
            </button>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">3. Effective Date</h2>
            <input
              type="date"
              value={effectiveDate}
              onChange={e => setEffectiveDate(e.target.value)}
              className="text-sm border border-[var(--ff-border-light)] rounded px-3 py-1.5 bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]"
            />
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Typically the first day of your new financial year</p>
          </div>

          <RowProblemsList problems={rowErrors} />

          {rows.length > 0 && (
            <>
              {/* Balance summary */}
              <div className={`rounded-lg border p-4 ${isBalanced ? 'border-teal-500/30 bg-teal-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-xs text-[var(--ff-text-secondary)]">Total Debit</p>
                    <p className="font-semibold text-[var(--ff-text-primary)]">{totalDebit.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--ff-text-secondary)]">Total Credit</p>
                    <p className="font-semibold text-[var(--ff-text-primary)]">{totalCredit.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--ff-text-secondary)]">Difference</p>
                    <p className={`font-semibold ${isBalanced ? 'text-teal-400' : 'text-red-400'}`}>
                      {isBalanced ? 'Balanced' : difference.toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">4. Preview ({rows.length} rows{rows.length > 15 ? ', first 15 shown' : ''})</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs divide-y divide-gray-200 dark:divide-gray-700">
                    <thead>
                      <tr className="bg-[var(--ff-bg-primary)]">
                        <th className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">Code</th>
                        <th className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">Name</th>
                        <th className="px-3 py-2 text-right text-[var(--ff-text-secondary)] font-medium">Debit</th>
                        <th className="px-3 py-2 text-right text-[var(--ff-text-secondary)] font-medium">Credit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {rows.slice(0, 15).map((r, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 font-mono text-[var(--ff-text-primary)]">{r.accountCode}</td>
                          <td className="px-3 py-1.5 text-[var(--ff-text-primary)]">{r.accountName}</td>
                          <td className="px-3 py-1.5 text-right text-[var(--ff-text-primary)]">
                            <input
                              type="number"
                              value={r.debit}
                              onChange={e => updateRow(i, 'debit', e.target.value)}
                              className="w-24 text-right border border-[var(--ff-border-light)] rounded px-1 bg-[var(--ff-bg-primary)]"
                            />
                          </td>
                          <td className="px-3 py-1.5 text-right text-[var(--ff-text-primary)]">
                            <input
                              type="number"
                              value={r.credit}
                              onChange={e => updateRow(i, 'credit', e.target.value)}
                              className="w-24 text-right border border-[var(--ff-border-light)] rounded px-1 bg-[var(--ff-bg-primary)]"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleImport}
                  disabled={isImporting || !isBalanced || rowErrors.length > 0}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Set Opening Balances
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
