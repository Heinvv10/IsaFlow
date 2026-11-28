/**
 * How many PO lines ended up linked to their item. PURE.
 *
 * The plan says how many lines it SENDS with item_code, but a PO already in the books is never changed by the PO tool (a replay
 * returns it as it is), so for those the plan's count would be a claim about lines nobody wrote. So after a live run the count is
 * MEASURED: the linked lines found in the books (`poLinkedLines`) for the POs this run created. POs that were already there are listed
 * as such and add nothing. A dry run (nothing written) reports what the plan would link for the POs it would create, labelled planned.
 */
import type { MigrationReport } from './sageMigrationTypes';
import type { MigrationPlan } from './sageMigrationPlan';

export function buildLineLinks(
  plan: Pick<MigrationPlan, 'purchaseOrders'>, before: { poTotals: ReadonlyMap<string, number> }, after: { poLinkedLines: ReadonlyMap<string, number>; poTotals: ReadonlyMap<string, number> } | null,
): MigrationReport['lineLinks'] {
  // The POs THIS run created: after a live run only those that are in the books (a PO of a failed batch is not one), a dry run those it would.
  const fresh = plan.purchaseOrders.filter((p) => !before.poTotals.has(p.sageId) && (after === null || after.poTotals.has(p.sageId)));
  return {
    linked: after ? fresh.reduce((n, p) => n + (after.poLinkedLines.get(p.sageId) ?? 0), 0) : fresh.reduce((n, p) => n + p.lineLinks.linked, 0),
    basis: after ? 'booked' : 'planned',
    notLinked: fresh.flatMap((p) => p.lineLinks.notLinked),
    alreadyThere: plan.purchaseOrders.filter((p) => before.poTotals.has(p.sageId)).map((p) => p.documentNumber),
  };
}
