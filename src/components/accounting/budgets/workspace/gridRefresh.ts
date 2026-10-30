/**
 * The in-place re-read after a write the budget drivers moved (P4): a driver, override, hire,
 * refresh or roll write, or a grid save in a version with drivers. No skeleton: the version is
 * fetched again and the store's unsaved edits are laid over it (PR-A `rebaseDirty`), as "reload
 * and re-apply mine" does. A read the caller no longer wants (a version or year switch started
 * meanwhile, a newer re-read) is dropped without a word; a failed read answers its message.
 */
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { rebaseDirty } from '@/modules/accounting/services/budgets/grid/diff';
import { fetchGridModel } from './budgetWorkspaceClient';
import type { GridStore } from './gridStore';
import { cellsInCents } from './gridStoreParts';

type Show = (m: GridReadModel, overlay?: { values: ReadonlyMap<string, number | null>; conflicts: string[] }) => void;

/** Null when shown (or dropped because `stillWanted` turned false), else what to tell the user. */
export async function refreshVersion(store: GridStore, versionId: string, stillWanted: () => boolean, show: Show): Promise<string | null> {
  const r = await fetchGridModel({ versionId });
  if (!stillWanted()) return null;
  if (!r.ok) return `The change was saved, but the budget could not be read again: ${r.message} Reload the page to see the recomputed figures.`;
  const mine = store.dirtyMap();
  const rebased = rebaseDirty(store.originalMap(), cellsInCents(r.data.cells), mine);
  show(r.data, mine.size > 0 ? { values: rebased.values, conflicts: rebased.conflicts } : undefined);
  return null;
}
