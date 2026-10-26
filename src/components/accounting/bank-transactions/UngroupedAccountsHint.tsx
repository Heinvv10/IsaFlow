/**
 * UngroupedAccountsHint — "5 accounts like ABSA - PC : … aren't in a group —
 * Move to <group>". Detection is ungroupedBankHint.ts; the move is the
 * existing grouping PUT (/api/accounting/bank-accounts, owner/admin), one
 * account at a time, stopping at the first refusal and saying why.
 */

import { useState } from 'react';
import { FolderInput, Loader2 } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { notify } from '@/utils/toast';
import type { UngroupedHint } from './ungroupedBankHint';

interface Props {
  hints: UngroupedHint[];
  /** Reloads the bank accounts once a move has changed any of them. */
  onMoved: () => void;
}

async function moveAll(hint: UngroupedHint): Promise<{ moved: number; error: string | null }> {
  let moved = 0;
  for (const a of hint.accounts) {
    try {
      const res = await apiFetch('/api/accounting/bank-accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: a.id, parentAccountId: hint.groupId }),
      });
      await assertOk(res, `Could not move ${a.accountName}`);
      moved += 1;
    } catch (err) {
      log.warn('Moving an ungrouped bank account failed', { error: err, accountId: a.id }, 'bank-transactions');
      return { moved, error: `${a.accountName}: ${apiErrorMessage(err, 'could not be moved')}` };
    }
  }
  return { moved, error: null };
}

export function UngroupedAccountsHint({ hints, onMoved }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  if (hints.length === 0) return null;

  const move = async (hint: UngroupedHint) => {
    setBusy(hint.groupId);
    const { moved, error } = await moveAll(hint);
    setBusy(null);
    if (error) notify.error(moved > 0 ? `Moved ${moved}, then stopped. ${error}` : error);
    else notify.success(`Moved ${moved} account${moved !== 1 ? 's' : ''} into ${hint.groupName}`);
    if (moved > 0) onMoved();
  };

  return (
    <div className="mt-3 space-y-2">
      {hints.map(h => (
        <div key={h.groupId} data-testid="ungrouped-hint" role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <FolderInput className="h-4 w-4 shrink-0 text-amber-800 dark:text-amber-400" />
          <span className="min-w-0 flex-1 text-[var(--ff-text-primary)]"
            title={h.accounts.map(a => a.accountName).join('\n')}>
            {h.accounts.length} accounts look like members of <span className="font-medium">{h.groupName}</span> but
            aren&apos;t in it
          </span>
          <button type="button" onClick={() => move(h)} disabled={busy !== null} data-testid="ungrouped-hint-move"
            className="flex items-center gap-1.5 rounded-md bg-teal-700 px-3 py-1 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-60">
            {busy === h.groupId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Move to {h.groupName}
          </button>
        </div>
      ))}
    </div>
  );
}
