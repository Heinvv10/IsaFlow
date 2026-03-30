import { useState, useRef, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Upload, Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import Papa from 'papaparse';

interface BalanceRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

interface ImportResult {
  journalId: string;
  balancesSet: number;
}

export default function OpeningBalancesPage() {
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [effectiveDate, setEffectiveDate] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  const difference = Math.abs(totalDebit - totalCredit);
  const isBalanced = difference < 0.01;

  const handleFile = (file: File) => {
    setError('');
    setImportResult(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => {
        const parsed: BalanceRow[] = data.map(r => ({
          accountCode: r['account_code'] ?? r['code'] ?? '',
          accountName: r['account_name'] ?? r['name'] ?? '',
          debit: parseFloat(r['debit_balance'] ?? r['debit'] ?? '0') || 0,
          credit: parseFloat(r['credit_balance'] ?? r['credit'] ?? '0') || 0,
        }));
        setRows(parsed);
      },
      error: err => setError(`CSV parse error: ${err.message}`),
    });
  };

  const updateRow = useCallback((i: number, field: 'debit' | 'credit', val: string) => {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: parseFloat(val) || 0 } : r));
  }, []);

  const handleImport = async () => {
    if (!effectiveDate) { setError('Please set an effective date'); return; }
    if (!isBalanced) { setError(`Trial balance is not balanced. Difference: ${difference.toFixed(2)}`); return; }
    setIsImporting(true);
    setError('');
    try {
      const sessionRes = await apiFetch('/api/accounting/migration/session');
      const sessionJson = await sessionRes.json();
      const sessionId = sessionJson.data?.id;
      if (!sessionId) throw new Error('No active migration session');

      const res = await apiFetch('/api/accounting/migration/opening-balances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          effectiveDate,
          balances: rows.map(r => ({ accountCode: r.accountCode, debit: r.debit, credit: r.credit })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Import failed');
      setImportResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  const downloadTemplate = async () => {
    const res = await apiFetch('/api/accounting/migration/templates?step=opening-balances');
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'opening-balances-template.csv';
    a.click();
    URL.revokeObjectURL(url);
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
          <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm mb-4">
            <CheckCircle2 className="h-4 w-4" />
            Opening balances set for {importResult.balancesSet} accounts. Journal ID: {importResult.journalId}
          </div>
        )}

        <div className="space-y-6">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">1. Download Template</h2>
            <button onClick={downloadTemplate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              <Download className="h-4 w-4" /> Download CSV Template
            </button>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">2. Upload Trial Balance CSV</h2>
            <p className="text-xs text-[var(--ff-text-secondary)] mb-3">Required columns: account_code, debit_balance, credit_balance</p>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
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
                <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">4. Preview ({rows.length} rows)</h2>
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
                  disabled={isImporting || !isBalanced}
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
