/**
 * Sage Migration Dashboard
 * PRD-060 Phase 6: Import Sage data into native GL
 *
 * Step 1: Map sage_accounts → gl_accounts
 * Step 2: Import sage_ledger_transactions → gl_journal_entries
 * Step 3: Import sage_supplier_invoices → supplier_invoices; Step 4: Compare Sage vs GL
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Database, ArrowRightLeft, FileSpreadsheet, Receipt,
  BarChart3, Loader2, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import {
  StepCard, MigrationStep, MigrationHistory, type MigrationStatus,
} from '@/components/accounting/sageMigration/sageMigrationParts';

interface ComparisonReport {
  comparisonDate: string;
  sageTotals: { totalDebit: number; totalCredit: number; accountCount: number };
  glTotals: { totalDebit: number; totalCredit: number; accountCount: number };
  differences: Array<{ accountCode: string; accountName: string; sageBalance: number; glBalance: number; difference: number }>;
  isBalanced: boolean;
}

export default function SageMigrationPage() {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [comparison, setComparison] = useState<ComparisonReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/sage-migration');
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setStatus(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load migration status');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const runAction = async (action: string, extra?: Record<string, string>) => {
    setActionLoading(action);
    setError('');
    setMessage('');
    try {
      const res = await apiFetch('/api/accounting/sage-migration-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Action failed');

      const data = json.data || json;

      if (action === 'compare') {
        setComparison(data);
        setMessage('Comparison report generated');
      } else if (action === 'reset') {
        setMessage(`Reset ${extra?.resetType} migration status`);
      } else {
        const run = data;
        const vatNote = run.vatNotStated > 0 ? `, ${run.vatNotStated} VAT not stated — review` : '';
        setMessage(`${action}: ${run.succeeded} succeeded, ${run.failed} failed, ${run.skipped} skipped${vatNote}`);
      }

      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading('');
    }
  };

  const noSageData = status && status.accounts.sageTotal === 0 && status.ledger.sageTotal === 0 && status.invoices.sageTotal === 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Accounting
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <Database className="h-6 w-6 text-orange-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Sage Migration</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Import Sage data into native General Ledger</p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}
          {message && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
              <CheckCircle2 className="h-4 w-4" /> {message}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
            </div>
          ) : noSageData ? (
            <div className="space-y-4">
              <div className="p-8 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-center">
                <Database className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-4" />
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">No Sage Data to Migrate</h2>
                <p className="text-[var(--ff-text-secondary)] max-w-lg mx-auto mb-4">
                  The Sage sync tables are empty. Once Sage data is synced to the local database
                  (sage_accounts, sage_ledger_transactions, sage_supplier_invoices),
                  return here to run the migration pipeline.
                </p>
                <div className="grid grid-cols-4 gap-4 mt-6 text-left">
                  <StepCard
                    step={1}
                    icon={<ArrowRightLeft className="h-5 w-5" />}
                    title="Map Accounts"
                    desc="Auto-map Sage accounts to GL chart of accounts"
                    status="waiting"
                  />
                  <StepCard
                    step={2}
                    icon={<FileSpreadsheet className="h-5 w-5" />}
                    title="Import Ledger"
                    desc="Convert Sage transactions to journal entries"
                    status="waiting"
                  />
                  <StepCard
                    step={3}
                    icon={<Receipt className="h-5 w-5" />}
                    title="Import Invoices"
                    desc="Migrate supplier invoices to AP module"
                    status="waiting"
                  />
                  <StepCard
                    step={4}
                    icon={<BarChart3 className="h-5 w-5" />}
                    title="Compare"
                    desc="Validate Sage vs GL balances match"
                    status="waiting"
                  />
                </div>
              </div>

              <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm">
                <p className="font-semibold text-blue-400 mb-1">How to sync Sage data</p>
                <p className="text-[var(--ff-text-secondary)]">
                  Use the Sage sync APIs to pull data:
                  <code className="mx-1 px-1.5 py-0.5 rounded bg-[var(--ff-bg-primary)] text-xs font-mono">POST /api/sage/sync/chart-of-accounts</code>
                  and
                  <code className="mx-1 px-1.5 py-0.5 rounded bg-[var(--ff-bg-primary)] text-xs font-mono">POST /api/sage/sync/invoices</code>
                </p>
              </div>
            </div>
          ) : status ? (
            <div className="space-y-6">
              {/* Step 1: Account Mapping */}
              <MigrationStep
                step={1}
                icon={<ArrowRightLeft className="h-5 w-5 text-blue-400" />}
                title="Account Mapping"
                desc={`${status.accounts.mapped}/${status.accounts.sageTotal} accounts mapped (${status.accounts.autoMapped} auto)`}
                progress={status.accounts.sageTotal > 0 ? (status.accounts.mapped / status.accounts.sageTotal) * 100 : 0}
                complete={status.accounts.sageTotal > 0 && status.accounts.unmapped === 0}
                onRun={() => runAction('auto_map')}
                onReset={() => runAction('reset', { resetType: 'accounts' })}
                loading={actionLoading === 'auto_map'}
                runLabel="Auto-Map"
              />

              {/* Step 2: Ledger Import */}
              <MigrationStep
                step={2}
                icon={<FileSpreadsheet className="h-5 w-5 text-purple-400" />}
                title="Ledger Transaction Import"
                desc={`${status.ledger.imported}/${status.ledger.sageTotal} transactions imported${status.ledger.failed > 0 ? `, ${status.ledger.failed} failed` : ''}`}
                progress={status.ledger.sageTotal > 0 ? (status.ledger.imported / status.ledger.sageTotal) * 100 : 0}
                complete={status.ledger.sageTotal > 0 && status.ledger.pending === 0}
                onRun={() => runAction('import_ledger')}
                onReset={() => runAction('reset', { resetType: 'ledger' })}
                loading={actionLoading === 'import_ledger'}
                runLabel="Import"
                disabled={status.accounts.unmapped > 0}
                disabledReason="Map all accounts first"
              />

              {/* Step 3: Invoice Import */}
              <MigrationStep
                step={3}
                icon={<Receipt className="h-5 w-5 text-amber-400" />}
                title="Supplier Invoice Import"
                desc={`${status.invoices.imported}/${status.invoices.sageTotal} invoices imported${status.invoices.failed > 0 ? `, ${status.invoices.failed} failed` : ''}`}
                progress={status.invoices.sageTotal > 0 ? (status.invoices.imported / status.invoices.sageTotal) * 100 : 0}
                complete={status.invoices.sageTotal > 0 && status.invoices.pending === 0}
                onRun={() => runAction('import_invoices')}
                onReset={() => runAction('reset', { resetType: 'invoices' })}
                loading={actionLoading === 'import_invoices'}
                runLabel="Import"
              />

              {/* Step 4: Comparison */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-teal-500/10 text-teal-400 text-sm font-bold">4</div>
                    <div>
                      <h3 className="font-semibold text-[var(--ff-text-primary)]">Parallel Run Comparison</h3>
                      <p className="text-xs text-[var(--ff-text-secondary)]">Compare Sage balances vs GL balances for validation</p>
                    </div>
                  </div>
                  <button
                    onClick={() => runAction('compare')}
                    disabled={actionLoading === 'compare'}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-50"
                  >
                    {actionLoading === 'compare' ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
                    Run Comparison
                  </button>
                </div>

                {comparison && (
                  <div className="space-y-3 mt-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="p-3 rounded-lg bg-[var(--ff-bg-primary)]">
                        <p className="text-xs text-[var(--ff-text-tertiary)]">Sage Accounts</p>
                        <p className="text-lg font-bold text-[var(--ff-text-primary)]">{comparison.sageTotals.accountCount}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-[var(--ff-bg-primary)]">
                        <p className="text-xs text-[var(--ff-text-tertiary)]">GL Accounts</p>
                        <p className="text-lg font-bold text-[var(--ff-text-primary)]">{comparison.glTotals.accountCount}</p>
                      </div>
                      <div className={`p-3 rounded-lg ${comparison.isBalanced ? 'bg-teal-500/10' : 'bg-red-500/10'}`}>
                        <p className="text-xs text-[var(--ff-text-tertiary)]">Status</p>
                        <p className={`text-lg font-bold ${comparison.isBalanced ? 'text-teal-400' : 'text-red-400'}`}>
                          {comparison.isBalanced ? 'Balanced' : `${comparison.differences.length} Differences`}
                        </p>
                      </div>
                    </div>

                    {comparison.differences.length > 0 && (
                      <div className="rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
                              <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)]">Account</th>
                              <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)]">Sage</th>
                              <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)]">GL</th>
                              <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)]">Diff</th>
                            </tr>
                          </thead>
                          <tbody>
                            {comparison.differences.map(d => (
                              <tr key={d.accountCode} className="border-b border-[var(--ff-border-light)]">
                                <td className="px-3 py-2 text-[var(--ff-text-primary)]">
                                  <span className="font-mono text-xs mr-2">{d.accountCode}</span>{d.accountName}
                                </td>
                                <td className="px-3 py-2 text-right font-mono">{formatCurrency(d.sageBalance)}</td>
                                <td className="px-3 py-2 text-right font-mono">{formatCurrency(d.glBalance)}</td>
                                <td className="px-3 py-2 text-right font-mono text-red-400">{formatCurrency(d.difference)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <MigrationHistory runs={status.lastRuns} />
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
