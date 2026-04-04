/**
 * BankTxBatchPanel — Batch edit panel + rule suggestion banner.
 * Rendered below the toolbar when batch-edit mode is active or a rule prompt is pending.
 */

import { useMemo } from 'react';
import { type AllocType, type SelectOption } from '@/components/accounting/BankTxTable';
import { extractPattern } from '@/components/accounting/CreateRuleModal';
import type { BankTx } from '@/components/accounting/BankTxTable';

export interface RulePrompt {
  tx: BankTx;
  matchCount: number;
}

interface Props {
  showBatchEdit: boolean;
  selectedCount: number;
  batchType: AllocType;
  batchSearch: string;
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  rulePrompt: RulePrompt | null;
  onBatchTypeChange: (type: AllocType) => void;
  onBatchSearchChange: (v: string) => void;
  onApplyBatchEdit: (entityId: string, label: string) => void;
  onCancelBatchEdit: () => void;
  onCreateRule: (tx: BankTx) => void;
  onDismissRulePrompt: () => void;
}

export function BankTxBatchPanel({
  showBatchEdit, selectedCount, batchType, batchSearch,
  glAccounts, suppliers, customers,
  rulePrompt,
  onBatchTypeChange, onBatchSearchChange, onApplyBatchEdit, onCancelBatchEdit,
  onCreateRule, onDismissRulePrompt,
}: Props) {
  const batchOptions = useMemo(() => {
    const opts = batchType === 'supplier' ? suppliers : batchType === 'customer' ? customers : glAccounts;
    if (!batchSearch) return opts.slice(0, 30);
    const q = batchSearch.toLowerCase();
    return opts.filter(o => (o.code || '').toLowerCase().includes(q) || o.name.toLowerCase().includes(q)).slice(0, 30);
  }, [batchType, batchSearch, glAccounts, suppliers, customers]);

  return (
    <>
      {/* Batch Edit Panel */}
      {showBatchEdit && selectedCount > 0 && (
        <div className="px-6 py-3 border-b border-blue-500/30 bg-blue-500/5 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-blue-400 font-medium">Batch Edit ({selectedCount} selected):</span>
          <select
            value={batchType}
            onChange={e => onBatchTypeChange(e.target.value as AllocType)}
            className="text-xs px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]"
          >
            <option value="account">Account</option>
            <option value="supplier">Supplier</option>
            <option value="customer">Customer</option>
          </select>
          <div className="relative">
            <input
              type="text"
              placeholder={`Search ${batchType}s...`}
              value={batchSearch}
              onChange={e => onBatchSearchChange(e.target.value)}
              className="pl-2 pr-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] w-52"
              autoFocus
            />
            <div className="absolute z-50 top-full left-0 mt-1 w-72 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl max-h-48 overflow-y-auto">
              {batchOptions.map(o => (
                <button
                  key={o.id}
                  onClick={() => onApplyBatchEdit(o.id, o.code ? `${o.code} ${o.name}` : o.name)}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2"
                >
                  {o.code && <span className="font-mono text-[var(--ff-text-tertiary)]">{o.code}</span>}
                  <span className="text-[var(--ff-text-primary)]">{o.name}</span>
                </button>
              ))}
              {batchOptions.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results found</div>
              )}
            </div>
          </div>
          <button
            onClick={onCancelBatchEdit}
            className="text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Rule suggestion banner */}
      {rulePrompt && (
        <div className="px-6 py-3 border-b border-yellow-500/30 bg-yellow-500/5 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-yellow-400 font-medium">
            {rulePrompt.matchCount} similar transaction{rulePrompt.matchCount !== 1 ? 's' : ''} found matching
            &ldquo;{extractPattern(rulePrompt.tx.description || '')}&rdquo;.
            Create a rule to auto-categorise them?
          </span>
          <button
            onClick={() => onCreateRule(rulePrompt.tx)}
            className="px-3 py-1 rounded bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-xs text-yellow-400 font-medium transition-colors"
          >
            Create Rule
          </button>
          <button
            onClick={onDismissRulePrompt}
            className="px-3 py-1 rounded text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]"
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
