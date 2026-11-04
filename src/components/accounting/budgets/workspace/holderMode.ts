/**
 * The budget grid's holder mode (budgets P5-6, decision 9a). When the read model names `holder`
 * (the viewer holds slices of this version and is not an owner or admin), the server has already
 * left out every other slice's cells; here each row is read-only outside the holder's slices, in a
 * slice with its reviewer, or on a version that is not a draft (`holderReadReason`, the same rule
 * the grid save enforces), and the grid opens on the holder's first slice. Cosmetic: the save route
 * and migration 955 refuse the same writes.
 */
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { View } from '@/modules/accounting/services/budgets/grid/pivot';
import { holderReadReason } from '@/modules/accounting/services/budgets/holderSlices';

/** The row rule for a budget holder of the version on screen; null for everyone else. */
export function holderRule(model: GridReadModel): ((accountId: string, view: View) => string | null) | null {
  const holder = model.holder;
  if (!holder) return null;
  const status = model.version?.status ?? 'draft';
  return (accountId, view) => holderReadReason(holder.slices, status, {
    glAccountId: accountId,
    cc1Id: view.kind === 'cc1' ? view.memberId : null,
    cc2Id: view.kind === 'cc2' ? view.memberId : null,
    buId: view.kind === 'bu' ? view.memberId : null,
  });
}

/**
 * The view a holder's grid opens on when `current` is the company view and they hold no
 * company-level slice: their first slice's member. Otherwise `current`.
 */
export function holderView(model: GridReadModel, current: View): View {
  const slices = model.holder?.slices ?? [];
  if (current.kind !== 'company' || slices.length === 0) return current;
  if (slices.some((s) => !s.cc1Id && !s.cc2Id && !s.buId)) return current;
  const first = slices[0]!;
  if (first.cc1Id) return { kind: 'cc1', memberId: first.cc1Id };
  if (first.cc2Id) return { kind: 'cc2', memberId: first.cc2Id };
  return { kind: 'bu', memberId: first.buId! };
}
