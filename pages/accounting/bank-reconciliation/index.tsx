/**
 * Bank Reconciliation List Page
 * PRD-060 Phase 4: Reconciliation sessions
 */

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  Landmark, Plus, Loader2, AlertCircle, ChevronRight, CheckCircle2,
} from 'lucide-react';
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import { EmptyState } from '@/components/ui';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    in_progress: 'bg-amber-500/20 text-amber-400',
    completed: 'bg-teal-500/20 text-teal-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default function BankReconciliationListPage() {
  const [reconciliations, setReconciliations] = useState<BankReconciliation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/bank-reconciliations');
      const json = await res.json();
      const data = json.data || json;
      setReconciliations(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load reconciliations');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const primaries: BankReconciliation[] = [];
    const order: string[] = [];
    const byGroup = new Map<string, { name: string; rows: BankReconciliation[] }>();
    for (const r of reconciliations) {
      if (r.groupId && r.groupName) {
        let g = byGroup.get(r.groupId);
        if (!g) { g = { name: r.groupName, rows: [] }; byGroup.set(r.groupId, g); order.push(r.groupId); }
        g.rows.push(r);
      } else {
        primaries.push(r);
      }
    }
    return { primaries, groups: order.map(id => ({ id, ...byGroup.get(id)! })) };
  }, [reconciliations]);

  const renderRow = (r: BankReconciliation, indent = false) => (
    <tr key={r.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors">
      <td className={`px-4 py-3 text-[var(--ff-text-primary)] ${indent ? 'pl-8' : ''}`}>{r.bankAccountName || '—'}</td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
        {new Date(r.statementDate).toLocaleDateString('en-ZA')}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
        {formatCurrency(r.statementBalance)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
        {formatCurrency(r.reconciledBalance)}
      </td>
      <td className={`px-4 py-3 text-right font-mono font-bold ${Math.abs(r.difference) < 0.01 ? 'text-teal-400' : 'text-red-400'}`}>
        {formatCurrency(r.difference)}
      </td>
      <td className="px-4 py-3 text-center">
        <span className="text-[var(--ff-text-secondary)]">
          {r.matchedCount ?? 0}
          {r.unmatchedCount !== undefined && <span className="text-[var(--ff-text-tertiary)]"> / {(r.matchedCount ?? 0) + (r.unmatchedCount ?? 0)}</span>}
        </span>
      </td>
      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
      <td className="px-4 py-3 text-right">
        <Link href={`/accounting/bank-reconciliation/${r.id}`} className="text-teal-500 hover:text-teal-400">
          {r.status === 'completed' ? <CheckCircle2 className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Link>
      </td>
    </tr>
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Landmark className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Reconciliation</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Match bank statements to GL entries
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/accounting/bank-reconciliation/import"
                className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)] hover:border-teal-500/50 transition-colors text-sm font-medium"
              >
                Import Statement
              </Link>
              <Link
                href="/accounting/bank-reconciliation/new"
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> New Reconciliation
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            </div>
          ) : reconciliations.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No reconciliations started yet"
              description="Import a bank statement to start matching transactions to your GL entries."
              primaryAction={{ label: 'Import Bank Statement', href: '/accounting/bank-reconciliation/import' }}
            />
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Bank Account</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Statement Date</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Statement Bal</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Reconciled Bal</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Difference</th>
                    <th className="text-center px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Matched</th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.primaries.map(r => renderRow(r))}
                  {grouped.groups.map(g => (
                    <Fragment key={g.id}>
                      <tr className="bg-[var(--ff-bg-primary)]/60">
                        <td colSpan={8} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-secondary)]">
                          {g.name} <span className="text-[var(--ff-text-tertiary)]">({g.rows.length})</span>
                        </td>
                      </tr>
                      {g.rows.map(r => renderRow(r, true))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
