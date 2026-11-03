/**
 * The budget grid as a budget holder sees it (budgets P5-6, spec §3f): only the cells of their own
 * slices; every other slice's cells are left out, so the band totals and the company roll-ups the
 * grid computes cover their slices only. When every one of their holder rows names its accounts,
 * only those accounts (and the headers above them) are listed. Owners, admins and members who hold
 * no slice of the version see the version whole (`holderFilter` answers null).
 */
import type { GridAccount, GridCell } from './gridReadTypes';
import { loadHolderScope, isHolder } from './holderScope';
import { sliceOf, type HolderView } from './holderSlices';

export interface HolderFilter {
  view: HolderView;
  /** The cells the holder may see. */
  cells: (cells: GridCell[]) => GridCell[];
  /** The listed accounts the holder may see (headers above a kept account stay). */
  accounts: (accounts: GridAccount[]) => GridAccount[];
  /** The slice members, so a slice with no amounts yet can still be picked in the grid's views. */
  members: { cc1: string[]; cc2: string[]; bu: string[] };
}

export async function holderFilter(companyId: string, versionId: string, userId: string | undefined): Promise<HolderFilter | null> {
  if (!userId) return null;
  const scope = await loadHolderScope(companyId, versionId, userId);
  if (!isHolder(scope)) return null;
  const slices = scope.slices;
  const limited = slices.every((s) => s.glAccountIds !== null);
  const allowed = new Set(slices.flatMap((s) => (s.glAccountIds ?? []).map((a) => a.toLowerCase())));
  return {
    view: { slices },
    cells: (cells) => cells.filter((c) => sliceOf(slices, c) !== null),
    accounts: (accounts) => (limited ? keepWithHeaders(accounts, allowed) : accounts),
    members: {
      cc1: slices.flatMap((s) => (s.cc1Id ? [s.cc1Id] : [])),
      cc2: slices.flatMap((s) => (s.cc2Id ? [s.cc2Id] : [])),
      bu: slices.flatMap((s) => (s.buId ? [s.buId] : [])),
    },
  };
}

/** The allowed accounts and every listed header above one of them; child lists keep only those. */
export function keepWithHeaders(accounts: GridAccount[], allowed: ReadonlySet<string>): GridAccount[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const keep = new Set<string>();
  for (const a of accounts) {
    if (!allowed.has(a.id.toLowerCase())) continue;
    for (let at: GridAccount | undefined = a; at && !keep.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) keep.add(at.id);
  }
  return accounts.filter((a) => keep.has(a.id)).map((a) => ({ ...a, childIds: a.childIds.filter((c) => keep.has(c)) }));
}
