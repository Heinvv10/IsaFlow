/**
 * Pure helpers for the import preview (spec 9.2): grouping the changed cells by account row and
 * the "changed N min ago" wording. Amounts are rand, as the preview carries them.
 */
import { parseKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { ImportChange } from '@/modules/accounting/services/budgets/budgetImportDiff';

export interface ChangeGroup {
  rowKey: string;
  glAccountId: string;
  /** The CC1 / CC2 / BU member ids on this row (null at company grain). */
  memberIds: readonly string[];
  /** month -> change */
  byMonth: ReadonlyMap<string, ImportChange>;
  changes: readonly ImportChange[];
}

/** One group per account x dimension row, in the order the changes first appear. */
export function groupChanges(changes: readonly ImportChange[]): ChangeGroup[] {
  const groups = new Map<string, { glAccountId: string; memberIds: string[]; changes: ImportChange[] }>();
  for (const c of changes) {
    const rowKey = rowKeyOf(c.key);
    let g = groups.get(rowKey);
    if (!g) {
      const ref = parseKey(c.key);
      g = { glAccountId: ref.glAccountId, memberIds: [ref.cc1Id, ref.cc2Id, ref.buId].filter((x): x is string => x !== null), changes: [] };
      groups.set(rowKey, g);
    }
    g.changes.push(c);
  }
  return [...groups].map(([rowKey, g]) => ({
    rowKey, glAccountId: g.glAccountId, memberIds: g.memberIds, changes: g.changes,
    byMonth: new Map(g.changes.map((c) => [parseKey(c.key).month, c])),
  }));
}

/** "changed 5 min ago" / "changed 3 h ago" / "changed 2 d ago" from the cell's last-write time. */
export function changedAgo(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const mins = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (mins < 1) return 'changed just now';
  if (mins < 60) return `changed ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `changed ${hours} h ago`;
  return `changed ${Math.round(hours / 24)} d ago`;
}
