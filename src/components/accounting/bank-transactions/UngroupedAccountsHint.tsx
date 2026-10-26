/**
 * UngroupedAccountsHint — "5 accounts look like members of <group> but aren't
 * in it". Detection is ungroupedBankHint.ts, a name heuristic, so the move is
 * never one click: "Review" lists the accounts and asks before anything
 * changes. The move is the existing grouping PUT (/api/accounting/bank-accounts,
 * owner/admin), one account at a time, stopping at the first refusal and
 * saying why. Other roles are told who can do it instead of being offered it.
 */

import { useState } from 'react';
import { FolderInput, Loader2 } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { notify } from '@/utils/toast';
import { useCompany } from '@/contexts/CompanyContext';
import type { UngroupedHint } from './ungroupedBankHint';

/** The roles the grouping PUT accepts. */
const GROUP_ROLES = ['owner', 'admin'];

interface Props {
  hints: UngroupedHint[];
  /** Reloads the bank accounts once a move has changed any of them. */
  onMoved: () => void;
}

export async function moveAll(hint: UngroupedHint): Promise<{ moved: number; error: string | null }> {
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

function HintRow({ hint, mayMove, roleKnown, busy, onMove }: {
  hint: UngroupedHint; mayMove: boolean; roleKnown: boolean; busy: boolean; onMove: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  return (
    <div data-testid="ungrouped-hint" role="status"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <FolderInput className="h-4 w-4 shrink-0 text-amber-800 dark:text-amber-400" />
        <span className="min-w-0 flex-1 text-[var(--ff-text-primary)]">
          {hint.accounts.length} accounts look like members of <span className="font-medium">{hint.groupName}</span> but
          aren&apos;t in it
          {roleKnown && !mayMove && <span className="text-[var(--ff-text-secondary)]"> — an owner or admin can move them</span>}
        </span>
        {mayMove && !reviewing && (
          <button type="button" onClick={() => setReviewing(true)} data-testid="ungrouped-hint-review"
            className="rounded-md border border-teal-700 px-3 py-1 text-xs font-medium text-teal-800 hover:bg-teal-700/10 dark:border-teal-400 dark:text-teal-300">
            Review
          </button>
        )}
      </div>
      {mayMove && reviewing && (
        <div className="mt-2 border-t border-amber-500/30 pt-2">
          <p className="text-xs text-[var(--ff-text-secondary)]">These accounts will be moved into {hint.groupName}:</p>
          <ul className="my-1.5 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-[var(--ff-text-primary)]" data-testid="ungrouped-hint-accounts">
            {hint.accounts.map(a => <li key={a.id}>{a.accountName} <span className="font-mono text-[var(--ff-text-tertiary)]">{a.accountCode}</span></li>)}
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={onMove} disabled={busy} data-testid="ungrouped-hint-move"
              className="flex items-center gap-1.5 rounded-md bg-teal-700 px-3 py-1 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-60">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Move {hint.accounts.length} to {hint.groupName}
            </button>
            <button type="button" onClick={() => setReviewing(false)} disabled={busy}
              className="rounded-md px-3 py-1 text-xs text-[var(--ff-text-secondary)] hover:underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function UngroupedAccountsHint({ hints, onMoved }: Props) {
  const { companyRole } = useCompany();
  // Null while the company is still loading: say nothing about who may move them until it is known.
  const roleKnown = companyRole != null;
  const mayMove = GROUP_ROLES.includes(companyRole ?? '');
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
        <HintRow key={h.groupId} hint={h} mayMove={mayMove} roleKnown={roleKnown} busy={busy === h.groupId} onMove={() => move(h)} />
      ))}
    </div>
  );
}
