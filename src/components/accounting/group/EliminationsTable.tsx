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

/** What the list says about a possible duplicate of a mirrored document: what is true, and "reverse" only for a posted row whose mirror is eliminated. */
export function duplicateText(adj: EliminationAdjustment): string {
  const m = adj.mirroredDuplicateOf;
  const shared = (adj.mirrorShared ?? 1) > 1 ? ` ${adj.mirrorShared} listed eliminations point at this mirror: at most one of them can be its duplicate.` : '';
  if (!adj.mirrorStands) {
    return `Possibly the same sale as mirrored document ${m}, which is NOT eliminated automatically at the moment (booked in another financial year, not approved yet, or reversed): this may be its only elimination.${shared}`;
  }
  if (adj.status === 'draft' && adj.pairCutover) {
    return `Possibly the same sale as mirrored document ${m}, which is eliminated automatically; the pair mirrors from ${adj.pairCutover}, and this row was drafted because that mirror accounts for another row or is not its closest match: check before posting.${shared}`;
  }
  if (adj.status === 'draft') return `Possibly the same sale as mirrored document ${m}, which is eliminated automatically: check before posting.${shared}`;
  return shared
    ? `Posted, and possibly the same sale as mirrored document ${m}, which is eliminated automatically.${shared} Check which, and reverse that one only.`
    : `Posted, and possibly the same sale as mirrored document ${m}, which is eliminated automatically: check, and reverse this one if so.`;
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
              <td className="px-4 py-3 text-[var(--ff-text-secondary)] max-w-xs">
                <div className="truncate" title={adj.description}>{adj.description}</div>
                {adj.manualReason && <div className="mt-0.5 text-xs text-[var(--ff-text-secondary)]">Reason: {adj.manualReason}</div>}
                {adj.mirroredDuplicateOf && (
                  <div role="note" className="mt-1 text-xs text-[var(--ff-text-primary)] border-l-2 border-amber-500/60 pl-2">
                    <span className="mr-1 inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-xs font-semibold">
                      Possible duplicate
                    </span>
                    {duplicateText(adj)}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 text-[var(--ff-text-tertiary)] font-mono text-xs">
                {adj.period}
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[adj.status]}`}>
                  {adj.automatic ? 'automatic' : adj.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-[var(--ff-text-primary)]">
                {fmt(adj.amount)}
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {!adj.automatic && adj.status === 'draft' && (
                    <button
                      onClick={() => onPost(adj.id)}
                      disabled={actionLoading === adj.id}
                      title="Post elimination"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-brand-600 text-white rounded-md hover:bg-brand-700 text-xs font-medium disabled:opacity-50"
                    >
                      {actionLoading === adj.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Send className="h-3 w-3" />}
                      Post
                    </button>
                  )}
                  {!adj.automatic && adj.status === 'posted' && (
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
