/**
 * Bank Reconciliation Detail Page
 * PRD-060 Phase 4: Main reconciliation work screen
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Landmark, Loader2, AlertCircle,
  Zap, Link2, Unlink, Ban, Check, Trash2,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';
import { ReconciliationBalances } from '@/components/accounting/bank/ReconciliationBalances';
import type { BankReconciliation, BankTransaction } from '@/modules/accounting/types/bank.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

function TxStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    imported: 'bg-gray-500/20 text-gray-400',
    matched: 'bg-blue-500/20 text-blue-400',
    allocated: 'bg-blue-500/20 text-blue-400',
    reconciled: 'bg-teal-500/20 text-teal-400',
    excluded: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

interface GLLine {
  id: string;
  debit: number;
  credit: number;
  description: string;
  entryDate: string;
  entryNumber: string;
}

export default function ReconciliationDetailPage() {
  const router = useRouter();
  const reconId = router.query.reconId as string;

  const [recon, setRecon] = useState<BankReconciliation | null>(null);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [glLines, setGlLines] = useState<GLLine[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  // Selected items for manual matching
  const [selectedTx, setSelectedTx] = useState<string | null>(null);
  const [selectedGl, setSelectedGl] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!reconId) return;
    setIsLoading(true);
    setError('');
    try {
      const [reconRes, txRes] = await Promise.all([
        apiFetch(`/api/accounting/bank-reconciliations?id=${reconId}`),
        apiFetch(`/api/accounting/bank-transactions?reconciliation_id=${reconId}&limit=500`),
      ]); await assertOk(reconRes, 'Could not load the reconciliation - try again'); await assertOk(txRes, 'Could not load the reconciliation transactions - try again');
      const reconJson = await reconRes.json();
      const reconData = reconJson.data || reconJson;
      setRecon(reconData);

      const txJson = await txRes.json();
      const txData = txJson.data || txJson;
      const loadedTransactions: BankTransaction[] = txData.transactions || [];
      setTransactions(loadedTransactions);

      // Load unmatched GL lines for this bank account
      if (reconData?.bankAccountId) {
        const glRes = await apiFetch(`/api/accounting/journal-entries?gl_account_id=${reconData.bankAccountId}&status=posted&limit=200`); await assertOk(glRes, 'Could not load the bank ledger lines - try again');
        const glJson = await glRes.json();
        const entries = glJson.data?.entries || glJson.entries || [];
        const lines: GLLine[] = [];
        for (const entry of entries) {
          if (entry.lines) {
            for (const line of entry.lines) {
              if (line.glAccountId === reconData.bankAccountId || line.gl_account_id === reconData.bankAccountId) {
                lines.push({
                  id: line.id,
                  debit: Number(line.debit || 0),
                  credit: Number(line.credit || 0),
                  description: line.description || entry.description || '',
                  entryDate: entry.entryDate || entry.entry_date || '',
                  entryNumber: entry.entryNumber || entry.entry_number || '',
                });
              }
            }
          }
        }
        // Filter out already matched
        const matchedLineIds = new Set(
          loadedTransactions.filter(t => t.matchedJournalLineId).map(t => t.matchedJournalLineId)
        );
        setGlLines(lines.filter(l => !matchedLineIds.has(l.id)));
      }
    } catch (err) {
      setRecon(null); setTransactions([]); setGlLines([]);
      setError(apiErrorMessage(err, 'Could not load the reconciliation - try again'));
    } finally {
      setIsLoading(false);
    }
  }, [reconId]);

  useEffect(() => { void loadData(); }, [loadData]);

  const postAction = async (url: string, body: Record<string, unknown>, fallback: string) => {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    await assertOk(res, fallback);
    return res.json();
  };
  const TX_URL = '/api/accounting/bank-transactions-action';
  const RECON_URL = '/api/accounting/bank-reconciliations-action';

  const handleAutoMatch = async () => {
    if (!recon) return;
    setActionLoading('auto_match');
    try {
      const json = await postAction(TX_URL, { action: 'auto_match', bankAccountId: recon.bankAccountId, reconciliationId: reconId }, 'Could not auto-match - try again');
      const data = (json?.data ?? {}) as {
        matched?: number; skippedRaced?: number; skippedUnavailable?: number;
      };
      setNotice(
        `Auto-matched ${data.matched ?? 0}` +
        (data.skippedRaced ? ` — ${data.skippedRaced} skipped (allocated by another request)` : '') +
        (data.skippedUnavailable
          ? ` — ${data.skippedUnavailable} skipped (bank table busy, retry in a moment)` : ''),
      );
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not auto-match - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const handleManualMatch = async () => {
    if (!selectedTx || !selectedGl) return;
    setActionLoading('match');
    try {
      await postAction(TX_URL, { action: 'match', bankTransactionId: selectedTx, journalLineId: selectedGl, reconciliationId: reconId }, 'Could not match - try again');
      setNotice('Transaction matched');
      setSelectedTx(null);
      setSelectedGl(null);
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not match - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const handleUnmatch = async (txId: string) => {
    setActionLoading(txId);
    try {
      await postAction(TX_URL, { action: 'unmatch', bankTransactionId: txId }, 'Could not unmatch - try again');
      setNotice('Transaction unmatched');
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not unmatch - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const handleExclude = async (txId: string) => {
    setActionLoading(txId);
    try {
      await postAction(TX_URL, { action: 'exclude', bankTransactionId: txId }, 'Could not exclude - try again');
      setNotice('Transaction excluded');
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not exclude - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const handleComplete = async () => {
    setActionLoading('complete');
    try {
      await postAction(RECON_URL, { action: 'complete', reconciliationId: reconId }, 'Could not complete the reconciliation - try again');
      setNotice('Reconciliation completed');
      await loadData();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not complete the reconciliation - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const handleCancelRecon = async () => {
    setActionLoading('cancel');
    setError('');
    try {
      // apiFetch resolves on 4xx — the status is the only signal that the
      // reconciliation was refused (already completed, reconciled rows).
      await postAction(RECON_URL, { action: 'cancel', reconciliationId: reconId }, 'Could not cancel the reconciliation - try again');
      setConfirmCancelOpen(false);
      await router.push('/accounting/bank-reconciliation');
    } catch (err) {
      setConfirmCancelOpen(false);
      setError(apiErrorMessage(err, 'Could not cancel the reconciliation - try again'));
    } finally {
      setActionLoading('');
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (!recon) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <div className="text-center"><p className="text-[var(--ff-text-secondary)]">{error || 'Reconciliation not found'}</p>{notice && <p className="mt-2 text-sm text-teal-400">{notice}</p>}</div>
        </div>
      </AppLayout>
    );
  }

  const unmatchedTxs = transactions.filter(t => t.status === 'imported');
  // An allocated line is matched to its own allocation journal line (bankReconciliationClaim).
  const matchedTxs = transactions.filter(t => t.status === 'matched' || t.status === 'reconciled'
    || (t.status === 'allocated' && !!t.matchedJournalLineId));
  const isCompleted = recon.status === 'completed';
  const canComplete = Math.abs(recon.difference) < 0.01 && !isCompleted;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting/bank-reconciliation" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Reconciliations
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <Landmark className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-[var(--ff-text-primary)]">
                    {recon.bankAccountName || 'Bank Reconciliation'}
                  </h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Statement: {new Date(recon.statementDate).toLocaleDateString('en-ZA')}
                    {isCompleted && <span className="ml-2 text-teal-400">Completed</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!isCompleted && (
                  <button
                    onClick={handleAutoMatch}
                    disabled={!!actionLoading || unmatchedTxs.length === 0}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm"
                  >
                    {actionLoading === 'auto_match' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    Auto-Match
                  </button>
                )}
                {!isCompleted && (
                  <button
                    onClick={() => setConfirmCancelOpen(true)}
                    disabled={!!actionLoading}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-transparent text-red-400 rounded-lg border border-red-500/40 hover:bg-red-500/10 disabled:opacity-50 transition-colors text-sm"
                  >
                    {actionLoading === 'cancel' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Cancel Reconciliation
                  </button>
                )}
                {canComplete && (
                  <button
                    onClick={handleComplete}
                    disabled={!!actionLoading}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors text-sm font-medium"
                  >
                    {actionLoading === 'complete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Complete Reconciliation
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
              <button onClick={() => setError('')} className="ml-auto text-xs underline">dismiss</button>
            </div>
          )}
          {notice && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-300 text-sm">
              {notice}
              <button onClick={() => setNotice('')} className="ml-auto text-xs underline">dismiss</button>
            </div>
          )}

          {/* Balances Summary */}
          <ReconciliationBalances recon={recon} />

          {/* Manual Match Controls */}
          {!isCompleted && selectedTx && selectedGl && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
              <Link2 className="h-4 w-4 text-blue-400" />
              <span className="text-sm text-blue-400">Ready to match selected items</span>
              <button
                onClick={handleManualMatch}
                disabled={!!actionLoading}
                className="ml-auto px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {actionLoading === 'match' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Match'}
              </button>
              <button
                onClick={() => { setSelectedTx(null); setSelectedGl(null); }}
                className="px-3 py-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Two-column layout: Bank Transactions | GL Lines */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Bank Transactions */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">
                  Bank Transactions ({unmatchedTxs.length} unmatched)
                </h3>
              </div>
              <div className="max-h-[500px] overflow-y-auto">
                {unmatchedTxs.length === 0 && matchedTxs.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--ff-text-tertiary)]">No transactions</p>
                ) : (
                  <div className="divide-y divide-[var(--ff-border-light)]">
                    {unmatchedTxs.map(tx => (
                      <div
                        key={tx.id}
                        onClick={() => !isCompleted && setSelectedTx(tx.id === selectedTx ? null : tx.id)}
                        className={`px-4 py-2 text-sm cursor-pointer transition-colors ${
                          selectedTx === tx.id ? 'bg-blue-500/10' : 'hover:bg-[var(--ff-bg-primary)]'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-[var(--ff-text-primary)] truncate">{tx.description || '—'}</p>
                            <p className="text-xs text-[var(--ff-text-tertiary)]">
                              {new Date(tx.transactionDate).toLocaleDateString('en-ZA')}
                              {tx.reference && ` | Ref: ${tx.reference}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 ml-2">
                            <span className={`font-mono text-sm ${tx.amount >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                              {formatCurrency(tx.amount)}
                            </span>
                            {!isCompleted && (
                              <button
                                onClick={e => { e.stopPropagation(); void handleExclude(tx.id); }}
                                className="p-1 text-[var(--ff-text-tertiary)] hover:text-red-400"
                                title="Exclude"
                              >
                                <Ban className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    {matchedTxs.length > 0 && (
                      <>
                        <div className="px-4 py-2 bg-[var(--ff-bg-primary)]">
                          <p className="text-xs font-medium text-teal-400">Matched ({matchedTxs.length})</p>
                        </div>
                        {matchedTxs.map(tx => (
                          <div key={tx.id} className="px-4 py-2 text-sm bg-teal-500/5">
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <p className="text-[var(--ff-text-primary)] truncate">{tx.description || '—'}</p>
                                <p className="text-xs text-[var(--ff-text-tertiary)]">
                                  {new Date(tx.transactionDate).toLocaleDateString('en-ZA')}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 ml-2">
                                <span className="font-mono text-sm text-[var(--ff-text-primary)]">
                                  {formatCurrency(tx.amount)}
                                </span>
                                <TxStatusBadge status={tx.status} />
                                {!isCompleted && tx.status === 'matched' && (
                                  <button
                                    onClick={() => handleUnmatch(tx.id)}
                                    className="p-1 text-[var(--ff-text-tertiary)] hover:text-amber-400"
                                    title="Unmatch"
                                  >
                                    <Unlink className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* GL Journal Lines */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">
                  GL Lines ({glLines.length} unmatched)
                </h3>
              </div>
              <div className="max-h-[500px] overflow-y-auto">
                {glLines.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--ff-text-tertiary)]">No unmatched GL lines</p>
                ) : (
                  <div className="divide-y divide-[var(--ff-border-light)]">
                    {glLines.map(line => {
                      const amount = line.debit > 0 ? line.debit : -line.credit;
                      return (
                        <div
                          key={line.id}
                          onClick={() => !isCompleted && setSelectedGl(line.id === selectedGl ? null : line.id)}
                          className={`px-4 py-2 text-sm cursor-pointer transition-colors ${
                            selectedGl === line.id ? 'bg-blue-500/10' : 'hover:bg-[var(--ff-bg-primary)]'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1 min-w-0">
                              <p className="text-[var(--ff-text-primary)] truncate">{line.description || '—'}</p>
                              <p className="text-xs text-[var(--ff-text-tertiary)]">
                                {line.entryNumber} | {new Date(line.entryDate).toLocaleDateString('en-ZA')}
                              </p>
                            </div>
                            <span className={`font-mono text-sm ml-2 ${amount >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                              {formatCurrency(amount)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancelOpen}
        title="Cancel this reconciliation?"
        message={
          <>
            The reconciliation session is deleted and its {transactions.length} transaction
            {transactions.length === 1 ? '' : 's'} are released back to the bank account.
            {'\n\n'}Matches made here are undone. Allocated and excluded transactions keep
            their status and their journal entries — nothing is removed from the GL.
          </>
        }
        confirmLabel="Cancel reconciliation"
        cancelLabel="Keep working"
        confirmTone="danger"
        busy={actionLoading === 'cancel'}
        onConfirm={handleCancelRecon}
        onCancel={() => setConfirmCancelOpen(false)}
      />
    </AppLayout>
  );
}
