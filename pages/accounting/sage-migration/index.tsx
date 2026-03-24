/**
 * Sage Migration Dashboard
 * PRD-060 Phase 6: Import Sage data into native GL
 *
 * Step 1: Map sage_accounts → gl_accounts
 * Step 2: Import sage_ledger_transactions → gl_journal_entries
 * Step 3: Import sage_supplier_invoices → supplier_invoices
 * Step 4: Compare Sage vs GL balances
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Database, ArrowRightLeft, FileSpreadsheet, Receipt,
  BarChart3, Loader2, AlertCircle, CheckCircle2, Play, RotateCcw,
} from 'lucide-react';

interface MigrationStatus {
  accounts: { sageTotal: number; mapped: number; unmapped: number; autoMapped: number };
  ledger: { sageTotal: number; imported: number; pending: number; failed: number; dateRange: { earliest: string | null; latest: string | null } };
  invoices: { sageTotal: number; imported: number; pending: number; failed: number };
  lastRuns: Array<{ id: string; runType: string; status: string; totalRecords: number; succeeded: number; failed: number; skipped: number; startedAt: string; completedAt: string | null }>;
}

interface ComparisonReport {
  comparisonDate: string;
  sageTotals: { totalDebit: number; totalCredit: number; accountCount: number };
  glTotals: { totalDebit: number; totalCredit: number; accountCount: number };
  differences: Array<{ accountCode: string; accountName: string; sageBalance: number; glBalance: number; difference: number }>;
  isBalanced: boolean;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
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
      const res = await fetch('/api/accounting/sage-migration');
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setStatus(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load migration status');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const runAction = async (action: string, extra?: Record<string, string>) => {
    setActionLoading(action);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/accounting/sage-migration-action', {
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
        setMessage(`${action}: ${run.succeeded} succeeded, ${run.failed} failed, ${run.skipped} skipped`);
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
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">
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
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-400 text-sm font-bold">4</div>
                    <div>
                      <h3 className="font-semibold text-[var(--ff-text-primary)]">Parallel Run Comparison</h3>
                      <p className="text-xs text-[var(--ff-text-secondary)]">Compare Sage balances vs GL balances for validation</p>
                    </div>
                  </div>
                  <button
                    onClick={() => runAction('compare')}
                    disabled={actionLoading === 'compare'}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50"
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
                      <div className={`p-3 rounded-lg ${comparison.isBalanced ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                        <p className="text-xs text-[var(--ff-text-tertiary)]">Status</p>
                        <p className={`text-lg font-bold ${comparison.isBalanced ? 'text-emerald-400' : 'text-red-400'}`}>
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

              {/* Migration History */}
              {status.lastRuns.length > 0 && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                  <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
                    <h3 className="font-semibold text-[var(--ff-text-primary)]">Migration History</h3>
                  </div>
                  <div className="divide-y divide-[var(--ff-border-light)]">
                    {status.lastRuns.map(run => (
                      <div key={run.id} className="px-5 py-3 flex items-center justify-between text-sm">
                        <div>
                          <span className="font-medium text-[var(--ff-text-primary)]">{run.runType.replace('_', ' ')}</span>
                          <span className="text-[var(--ff-text-tertiary)] text-xs ml-2">
                            {new Date(run.startedAt).toLocaleDateString('en-ZA')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-[var(--ff-text-secondary)]">
                            {run.succeeded} ok / {run.failed} fail / {run.skipped} skip
                          </span>
                          <StatusBadge status={run.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}

function StepCard({ step, icon, title, desc, status }: {
  step: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  status: 'waiting' | 'ready' | 'done';
}) {
  return (
    <div className="p-4 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
      <div className="flex items-center gap-2 mb-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--ff-bg-secondary)] text-[var(--ff-text-tertiary)] text-xs font-bold">{step}</span>
        <span className="text-[var(--ff-text-tertiary)]">{icon}</span>
      </div>
      <p className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</p>
      <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">{desc}</p>
      {status === 'waiting' && <p className="text-xs text-[var(--ff-text-tertiary)] mt-2 italic">Waiting for data</p>}
    </div>
  );
}

function MigrationStep({ step, icon, title, desc, progress, complete, onRun, onReset, loading, runLabel, disabled, disabledReason }: {
  step: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  progress: number;
  complete: boolean;
  onRun: () => void;
  onReset: () => void;
  loading: boolean;
  runLabel: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${complete ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400'}`}>
            {complete ? <CheckCircle2 className="h-4 w-4" /> : step}
          </div>
          <div>
            <h3 className="font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
              {icon} {title}
            </h3>
            <p className="text-xs text-[var(--ff-text-secondary)]">{desc}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onReset}
            className="p-2 rounded-lg text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)] transition-colors"
            title="Reset"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            onClick={onRun}
            disabled={loading || disabled}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
            title={disabled ? disabledReason : undefined}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {runLabel}
          </button>
        </div>
      </div>
      <div className="h-2 rounded-full bg-[var(--ff-bg-primary)] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${complete ? 'bg-emerald-500' : 'bg-blue-500'}`}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-emerald-500/20 text-emerald-400',
    partial: 'bg-amber-500/20 text-amber-400',
    failed: 'bg-red-500/20 text-red-400',
    running: 'bg-blue-500/20 text-blue-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}
