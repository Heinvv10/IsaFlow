/**
 * "Copy into a new draft version" (spec §7.3, locked 409): a P1 copy of the version, then my
 * unsaved cells re-applied onto it (`reapplyMine(copyId)`). The copy and the load are two steps:
 * when the copy is made but its load fails, the copy is REMEMBERED (`pendingCopy`) and the next
 * call only retries the load into that copy, so trying again never makes a second copy. Anything
 * else that loads the grid (a year or version switch, a reload) forgets it; the copy stays in the
 * version list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BudgetVersionKind } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { copyVersion } from './budgetWorkspaceClient';
import { failureText } from './failureText';
import type { BudgetGridApi } from './useBudgetGrid';

export interface PendingCopy { id: string; name: string }

export type CopyReapplyResult =
  | { ok: true }
  /** 'copy': no copy was made. 'load': the copy `copyName` exists but is not on screen; call again to retry. */
  | { ok: false; stage: 'copy' | 'load'; message: string; copyName: string | null };

export interface CopyReapply {
  pendingCopy: PendingCopy | null;
  copyAndReapply(body: { name: string; kind: BudgetVersionKind }): Promise<CopyReapplyResult>;
}

export function useCopyReapply(grid: Pick<BudgetGridApi, 'model' | 'version' | 'reapplyMine'>): CopyReapply {
  const [pendingCopy, setPendingCopy] = useState<PendingCopy | null>(null);
  const pending = useRef<PendingCopy | null>(null);
  const remember = (p: PendingCopy | null) => { pending.current = p; setPendingCopy(p); };

  // A new load of the grid (year, version, reload) means the user moved on: forget the copy.
  // A failed re-apply loads nothing, so it never clears what it just remembered.
  useEffect(() => { remember(null); }, [grid.model]);

  const { version, reapplyMine } = grid;
  const copyAndReapply = useCallback(async (body: { name: string; kind: BudgetVersionKind }): Promise<CopyReapplyResult> => {
    let target = pending.current;
    if (!target) {
      if (!version) return { ok: false, stage: 'copy', message: 'There is no budget version to copy.', copyName: null };
      const copy = await copyVersion(version.id, body);
      if (!copy.ok) return { ok: false, stage: 'copy', message: failureText(copy), copyName: null };
      target = { id: copy.data.id, name: copy.data.name };
    }
    const notLoaded = await reapplyMine(target.id);
    if (notLoaded === null) { remember(null); return { ok: true }; }
    remember(target);
    return { ok: false, stage: 'load', message: notLoaded, copyName: target.name };
  }, [version, reapplyMine]);

  return { pendingCopy, copyAndReapply };
}
