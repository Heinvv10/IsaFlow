/**
 * A document posts the CC1 / CC2 / BU it STORES — the ones its approval digest
 * covers (migration 873) — and nothing more.
 *
 * Two derivations used to run at POST time: the customer's FNO filled a revenue
 * line saved without a CC1 (customerInvoiceRevenueLines), and createJournalEntry
 * derives CC1 from the CC2's CURRENT parent. A customer FNO set, or a project
 * re-parented, after approval then changed what posted while the approval
 * still cleared. Writers now store the effective dimensions
 * (deriveRevenueDimensions), and every document posting passes POST_AS_STORED
 * so createJournalEntry copies them instead of re-deriving.
 *
 * APPROVING a document (from draft or pending_approval) is where a stale row is
 * caught: a line posting would once have added a CC1 to, a stored CC1 its
 * project now contradicts, or a dimension no longer this company's active
 * master is refused, so the draft is re-saved and approved on what it stores.
 * A document already past draft (Post to GL, the backfill route) is posted
 * exactly as stored, refusing nothing: its approval stands, and refusing would
 * leave it in AR or AP with no journal.
 */
import { DimensionRefusal, type DimensionIds } from './dimensionTypes';
import { deriveLineDimensions } from './dimensionDerivation';
import { assertDocumentDimensions } from './dimensionPolicy';

/** createJournalEntry opts for a document posting: its stored dimensions, copied, never re-derived. */
export const POST_AS_STORED = { dimensionAssignmentMode: 'historical-copy' } as const;

/** The statuses a document is approved FROM — the only ones this refuses in. */
const APPROVING_FROM: ReadonlySet<string> = new Set(['draft', 'pending_approval']);

/** Whether a document posted from `status` is being APPROVED (as opposed to posted past draft). */
export const isApprovingFrom = (status: string): boolean => APPROVING_FROM.has(status);

export async function assertPostsStoredDimensions(
  companyId: string,
  status: string,
  lines: readonly DimensionIds[],
  label: (index: number) => string,
  customerFnoId: string | null = null,
): Promise<void> {
  if (!APPROVING_FROM.has(status)) return;
  const refuse = (i: number, source: string): never => {
    throw new DimensionRefusal(
      `${label(i)} carries no CC1 (FNO), but its ${source} would add one that was never saved with it. `
      + 'Re-save the draft so the FNO is stored with it, then approve it.',
    );
  };
  if (customerFnoId) {
    const bare = lines.findIndex((l) => !l.cc1Id);
    if (bare >= 0) refuse(bare, "customer's FNO");
  }
  // A stored CC1 its project now contradicts is refused here (DimensionRefusal).
  const derived = await deriveLineDimensions(companyId, lines, label);
  const added = derived.findIndex((d, i) => d.cc1Id && !lines[i]!.cc1Id);
  if (added >= 0) refuse(added, "project's FNO");
  await assertDocumentDimensions(companyId, lines);
}
