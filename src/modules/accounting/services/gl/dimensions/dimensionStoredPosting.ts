/**
 * A document posts the CC1 / CC2 / BU it STORES — the ones its approval digest
 * covers (migration 873) — and nothing more.
 *
 * Two derivations used to run at POST time: the customer's FNO filled a revenue
 * line saved without a CC1 (customerInvoiceRevenueLines), and createJournalEntry
 * derives CC1 from the CC2's CURRENT parent. A customer FNO set, or a project
 * re-parented, after approval then changed what posted while the approval
 * still cleared. Writers now store the effective dimensions
 * (deriveRevenueDimensions); a row saved before that, which posting would add a
 * CC1 to, is refused here so the draft is re-saved — and re-approved — rather
 * than posted with a dimension nobody approved. A stored CC1 that contradicts
 * its project's current FNO is refused by the derivation itself.
 */
import { DimensionRefusal, type DimensionIds } from './dimensionTypes';
import { deriveLineDimensions } from './dimensionDerivation';

export async function assertPostsStoredDimensions(
  companyId: string,
  lines: readonly DimensionIds[],
  label: (index: number) => string,
  customerFnoId: string | null = null,
): Promise<void> {
  const refuse = (i: number, source: string): never => {
    throw new DimensionRefusal(
      `${label(i)} carries no CC1 (FNO), but posting would add ${source}, which its approval does not cover. `
      + 'Re-save the draft so the FNO it posts is stored with it, then have it approved again.',
    );
  };
  const bare = lines.flatMap((l, i) => (l.cc1Id ? [] : [i]));
  if (bare.length === 0) return;
  if (customerFnoId) refuse(bare[0]!, "the customer's FNO");
  const withProject = bare.filter((i) => lines[i]!.cc2Id);
  if (withProject.length === 0) return;
  const derived = await deriveLineDimensions<DimensionIds>(companyId, withProject.map((i) => ({ cc2Id: lines[i]!.cc2Id })));
  const k = derived.findIndex((d) => d.cc1Id);
  if (k >= 0) refuse(withProject[k]!, "its project's FNO");
}
