/**
 * What each live customer note linked to an invoice with NO allocation rows (approved before migration 874) reversed
 * of that invoice's revenue legs, by the SAME replay posting uses (invoiceRevenueLines.replayLegacyNotes), over the same
 * legs and the same notes in the same order, read by the same queries (invoiceCreditBasisRead, round 9: one source).
 * Rule A's detached gross of such a note is then only its true excess (creditNoteDetachedRead; #1701 round 8 item 6:
 * treating its whole gross as detached counted it against another typed invoice as well). Company-scoped.
 */
import { replayLegacyNotes } from './invoiceRevenueLines';
import { NO_NOTE, invoiceRevenueLegs, legacyLinkedNotes } from './invoiceCreditBasisRead';

/** note id -> the net (cents) the replay has it take from `invoiceId`'s legs. */
export async function legacyReplayTakes(companyId: string, invoiceId: string): Promise<Map<string, number>> {
  // The replay reads only each leg's net; no post account is needed.
  const legs = await invoiceRevenueLegs(companyId, invoiceId, NO_NOTE, NO_NOTE);
  const notes = await legacyLinkedNotes(companyId, invoiceId, NO_NOTE);
  const { took } = replayLegacyNotes(legs, notes.map((n) => n.subtotal));
  return new Map(notes.map((n, i) => [n.id, took[i]!]));
}
