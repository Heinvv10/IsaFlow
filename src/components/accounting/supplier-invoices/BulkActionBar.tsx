/**
 * Floating bar that surfaces bulk actions when one or more rows are selected.
 * Calls /supplier-invoices-bulk-action — single atomic endpoint, no parallel
 * fan-out from the client.
 */

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';
import { notifyPostingWarnings } from '@/components/accounting/postingWarningsNotice';
import { log } from '@/lib/logger';

type BulkAction = 'approve' | 'post_gl' | 'cancel';

interface BulkActionResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ invoiceId: string; ok: boolean; error?: string }>;
}

interface Props {
  selected: ReadonlySet<string>;
  busy: BulkAction | null;
  onBusyChange: (b: BulkAction | null) => void;
  /** The page's error setter: the refusal is joined to whatever the reload left. */
  onError: Dispatch<SetStateAction<string>>;
  onComplete: () => void | Promise<void>;
  onClear: () => void;
}

const VERB: Record<BulkAction, string> = {
  approve: 'Approve',
  post_gl: 'Post to GL',
  cancel: 'Cancel',
};
const COULD_NOT: Record<BulkAction, string> = {
  approve: 'Could not approve the invoices - try again',
  post_gl: 'Could not post the invoices to the GL - try again',
  cancel: 'Could not cancel the invoices - try again',
};
const PLURAL: Record<BulkAction, string> = { approve: 'approves', post_gl: 'GL postings', cancel: 'cancels' };

export function BulkActionBar({
  selected, busy, onBusyChange, onError, onComplete, onClear,
}: Props) {
  if (selected.size === 0) return null;

  async function run(action: BulkAction) {
    if (!window.confirm(`${VERB[action]} ${selected.size} invoice(s)?`)) return;
    onBusyChange(action);
    onError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-bulk-action', {
        method: 'POST',
        body: JSON.stringify({ action, invoiceIds: Array.from(selected) }),
      });
      await assertOk(res, COULD_NOT[action]);
      const json = await res.json();
      const data = (json.data || json) as BulkActionResult;
      let failure = '';
      if (data.failed > 0) {
        // Group by message rather than showing only the first: a mixed
        // selection typically fails for ONE reason (a status the action
        // refuses), and the operator needs to know which reason and how many,
        // not the first id's message alone.
        const byReason = new Map<string, number>();
        for (const r of data.results) {
          if (r.ok) continue;
          const reason = r.error || 'no reason was given';
          byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        }
        const detail = Array.from(byReason.entries())
          .map(([reason, count]) => (byReason.size > 1 ? `${count}× ${reason}` : reason))
          .join('; ');
        failure = `${data.failed} of ${data.total} ${PLURAL[action]} failed${detail ? `: ${detail}` : ''}`;
      }
      // Reload first: the page's reload clears its error, so a failure set
      // before it would vanish as soon as it appeared. Join rather than
      // replace, so a failed reload still says the list is stale.
      await onComplete();
      notifyLateClaims(json); // bills whose VAT was claimed in a later period (s16(3))
      notifyPostingWarnings(json); // bills posted without a cost centre that could not be applied
      if (failure) onError((prev) => (prev ? `${prev} — ${failure}` : failure));
    } catch (err) {
      log.warn('Bulk action failed', { action, error: err }, 'supplier-invoices');
      onError(apiErrorMessage(err, COULD_NOT[action]));
    } finally {
      onBusyChange(null);
    }
  }

  return (
    <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl px-4 py-2.5">
      <span className="text-sm text-amber-700 dark:text-amber-300 font-medium">
        {selected.size} selected
      </span>
      <div className="flex gap-2 ml-auto">
        <BulkButton onClick={() => run('approve')} disabled={busy !== null} busy={busy === 'approve'} tone="emerald">
          Approve
        </BulkButton>
        <BulkButton onClick={() => run('post_gl')} disabled={busy !== null} busy={busy === 'post_gl'} tone="blue">
          Post to GL
        </BulkButton>
        <BulkButton onClick={() => run('cancel')} disabled={busy !== null} busy={busy === 'cancel'} tone="red">
          Cancel
        </BulkButton>
        <button
          type="button"
          onClick={onClear}
          className="px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-md"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

const TONE_CLASSES = {
  emerald: 'bg-emerald-600 hover:bg-emerald-700',
  blue: 'bg-blue-600 hover:bg-blue-700',
  red: 'bg-red-600 hover:bg-red-700',
} as const;

function BulkButton({
  onClick, disabled, busy, tone, children,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  tone: keyof typeof TONE_CLASSES;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-xs font-semibold rounded-md text-white transition-colors disabled:opacity-50 ${TONE_CLASSES[tone]}`}
    >
      {busy ? '…' : children}
    </button>
  );
}
