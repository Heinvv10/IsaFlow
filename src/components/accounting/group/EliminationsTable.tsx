/**
 * EliminationsTable
 * Renders the list of elimination adjustments with post/reverse actions.
 */

import { Loader2, Building2, Send, RotateCcw } from 'lucide-react';
import {
  fmt,
  STATUS_STYLES,
  ELIMINATION_TYPE_LABELS,
  type EliminationAdjustment,
} from './EliminationsShared';

interface Props {
  items: EliminationAdjustment[];
  loading: boolean;
  actionLoading: string | null;
  onPost: (id: string) => void;
  onReverse: (id: string) => void;
}

export function EliminationsTable({ items, loading, actionLoading, onPost, onReverse }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <Building2 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
        <p className="text-[var(--ff-text-secondary)]">No elimination adjustments found</p>
        <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
          Use &ldquo;Auto-Generate&rdquo; to detect intercompany transactions or create manually
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
            <th className="px-4 py-3">Number</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Description</th>
            <th className="px-4 py-3">Period</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Amount</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((adj) => (
            <tr
              key={adj.id}
              className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
            >
              <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)]">{adj.number}</td>
              <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                {ELIMINATION_TYPE_LABELS[adj.type] || adj.type}
              </td>
              <td className="px-4 py-3 text-[var(--ff-text-secondary)] max-w-xs truncate">
                {adj.description}
              </td>
              <td className="px-4 py-3 text-[var(--ff-text-tertiary)] font-mono text-xs">
                {adj.period}
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[adj.status]}`}>
                  {adj.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                {fmt(adj.amount)}
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {adj.status === 'draft' && (
                    <button
                      onClick={() => onPost(adj.id)}
                      disabled={actionLoading === adj.id}
                      title="Post elimination"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-teal-600 text-white rounded-md hover:bg-teal-700 text-xs font-medium disabled:opacity-50"
                    >
                      {actionLoading === adj.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Send className="h-3 w-3" />}
                      Post
                    </button>
                  )}
                  {adj.status === 'posted' && (
                    <button
                      onClick={() => onReverse(adj.id)}
                      disabled={actionLoading === adj.id}
                      title="Reverse elimination"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-amber-600 text-white rounded-md hover:bg-amber-700 text-xs font-medium disabled:opacity-50"
                    >
                      {actionLoading === adj.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <RotateCcw className="h-3 w-3" />}
                      Reverse
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
