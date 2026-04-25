/**
 * Floating bar that surfaces bulk actions when one or more rows are selected.
 * Calls /supplier-invoices-bulk-action — single atomic endpoint, no parallel
 * fan-out from the client.
 */

import type { ReactNode } from 'react';
import { apiFetch } from '@/lib/apiFetch';
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
  onError: (msg: string) => void;
  onComplete: () => void | Promise<void>;
  onClear: () => void;
}

const VERB: Record<BulkAction, string> = {
  approve: 'Approve',
  post_gl: 'Post to GL',
  cancel: 'Cancel',
};

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
      const json = await res.json();
      if (!res.ok) {
        onError(json?.error?.message || json?.message || `${action} failed`);
        return;
      }
      const data = (json.data || json) as BulkActionResult;
      if (data.failed > 0) {
        const firstError = data.results.find((r) => !r.ok)?.error || '';
        onError(`${data.failed} of ${data.total} ${action}s failed${firstError ? `: ${firstError}` : ''}`);
      }
      await onComplete();
    } catch (err) {
      log.warn('Bulk action failed', { action, error: err }, 'supplier-invoices');
      onError(`${action} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
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
