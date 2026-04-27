/**
 * Page header bar for the bank rules page: title, bank-account selector,
 * bulk-delete trigger, run-rules trigger, new-rule trigger. Extracted from
 * rules.tsx to keep the page under the 300-line file budget.
 */

import Link from 'next/link';
import { ArrowLeft, Zap, Plus, Trash2, Loader2, Play } from 'lucide-react';

export interface BankRulesHeaderBankAccount {
  id: string;
  accountCode: string;
  accountName: string;
}

interface BankRulesHeaderProps {
  bankAccounts: BankRulesHeaderBankAccount[];
  selectedBankId: string;
  onSelectBank: (id: string) => void;
  selectedCount: number;
  bulkDeleting: boolean;
  onRequestBulkDelete: () => void;
  busy: string;
  onRequestRunRules: () => void;
  onClickNewRule: () => void;
}

export function BankRulesHeader({
  bankAccounts,
  selectedBankId,
  onSelectBank,
  selectedCount,
  bulkDeleting,
  onRequestBulkDelete,
  busy,
  onRequestRunRules,
  onClickNewRule,
}: BankRulesHeaderProps) {
  return (
    <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
      <Link
        href="/accounting/bank-reconciliation"
        className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Reconciliation
      </Link>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-yellow-500/10">
            <Zap className="h-6 w-6 text-yellow-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Categorisation Rules</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">
              Auto-categorise bank transactions by pattern matching.{' '}
              <span className="text-[var(--ff-text-muted)]">
                Suggest rules attach a category for review; auto-post rules also post a journal entry.
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {bankAccounts.length > 1 && (
            <select
              value={selectedBankId}
              onChange={e => onSelectBank(e.target.value)}
              aria-label="Bank account"
              className="ff-select text-sm py-2 px-3"
            >
              {bankAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>
              ))}
            </select>
          )}
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={onRequestBulkDelete}
              disabled={bulkDeleting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
            >
              {bulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete {selectedCount} selected
            </button>
          )}
          <button
            type="button"
            onClick={onRequestRunRules}
            disabled={!!busy || !selectedBankId}
            title="Run all active rules. Auto-post rules will create journal entries; suggest rules attach a category for review."
            aria-label="Run rules now"
            className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
          >
            {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run rules now
          </button>
          <button
            type="button"
            onClick={onClickNewRule}
            className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm font-medium"
          >
            <Plus className="h-4 w-4" /> New Rule
          </button>
        </div>
      </div>
    </div>
  );
}
