/**
 * IntercompanyTable
 * Transaction table with checkbox-based match selection.
 */

import { Loader2, ArrowLeftRight } from 'lucide-react';
import { fmt, STATUS_STYLES } from './IntercompanyShared';
import type { IntercompanyTx } from './IntercompanyShared';

interface Props {
  transactions: IntercompanyTx[];
  loading: boolean;
  matchSelection: string[];
  onToggleSelect: (id: string) => void;
}

export function IntercompanyTable({ transactions, loading, matchSelection, onToggleSelect }: Props) {
  if (loading) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-12 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-12 text-center text-[var(--ff-text-tertiary)]">
        <ArrowLeftRight className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No intercompany transactions found</p>
      </div>
    );
  }

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs uppercase">
              <th className="px-4 py-3 text-left w-8" />
              <th className="px-4 py-3 text-left">Date</th>
              <th className="px-4 py-3 text-left">Source Company</th>
              <th className="px-4 py-3 text-left">Target Company</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {transactions.map((tx) => {
              const isSelected = matchSelection.includes(tx.id);
              const canSelect = tx.status === 'unmatched' || tx.status === 'partial';
              return (
                <tr
                  key={tx.id}
                  onClick={() => canSelect && onToggleSelect(tx.id)}
                  className={`hover:bg-[var(--ff-bg-tertiary)] transition-colors ${
                    canSelect ? 'cursor-pointer' : ''
                  } ${isSelected ? 'bg-purple-500/5' : ''}`}
                >
                  <td className="px-4 py-3">
                    {canSelect && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect(tx.id)}
                        className="rounded border-[var(--ff-border-light)]"
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)] whitespace-nowrap">
                    {tx.date?.split('T')[0]}
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)]">{tx.sourceCompanyName}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)]">{tx.targetCompanyName}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">
                    {tx.type.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                    {fmt(tx.amount, tx.currency)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${
                        STATUS_STYLES[tx.status] || STATUS_STYLES['unmatched']
                      }`}
                    >
                      {tx.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
