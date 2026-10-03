/**
 * D10 O9: a statement line that a bank-first PROVISIONAL journal X books (`provisional_je_id` set, no matched journal
 * line) is not reset while X stands — by a bank reversal, an unmatch, an exclude or a match. X's bank credit IS this
 * line's cash: resetting the line left the cash booked by X with the line free to be allocated a second time, and a
 * later approval of the slip's bill settled X against it. Called on the LOCKED line, before any write.
 *
 * Mirrors the bank reversal of an un-evidenced provisional's line, which was always refused (its status is
 * 'provisional'), now with a typed refusal naming the undo that exists:
 *   - un-evidenced X: Dismiss (bank/provisionalDismissService) reverses X and frees the line;
 *   - evidenced X: dismiss refuses it; approving the bill the slip backs settles X (ap/provisionalSettlementClaim),
 *     and voiding that payment once unapplied reverses X and its reclass and frees the line
 *     (ap/provisionalSettlementVoid);
 *   - settled X: the R-127 refusal (`refuseSettledProvisionalLine`).
 * A line whose X the GL already took out is no longer booked by it: the bank reversal frees it and clears the link
 * (the caller, on `true`); the other verbs refuse and point at that reversal.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { refuseSettledProvisionalLine, UNAPPLY_REMEDY } from '../ap/provisionalSettlementGuards';
import { brokenChainMessage, findJournalChainHead } from '../shared/journalChainHead';

export type ProvisionalLineVerb = 'reverse' | 'unmatch' | 'exclude' | 'match';
const VERBING: Record<ProvisionalLineVerb, string> = {
  reverse: 'Reversing', unmatch: 'Unmatching', exclude: 'Excluding', match: 'Matching',
};

/** True when the line is linked to a provisional the GL has already taken out (only `reverse` gets here with it). */
export async function refuseResettingProvisionalLine(
  companyId: string,
  tx: { provisional_je_id?: unknown; matched_journal_line_id?: unknown },
  verb: ProvisionalLineVerb,
): Promise<boolean> {
  if (!tx.provisional_je_id || tx.matched_journal_line_id) return false;
  await refuseSettledProvisionalLine(companyId, tx);
  const jeId = String(tx.provisional_je_id);
  const [je] = (await sql`
    SELECT entry_number, needs_evidence FROM gl_journal_entries
    WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const chain = je ? await findJournalChainHead(companyId, jeId) : null;
  if (chain?.kind === 'broken') throw new BankAllocationRefusal(brokenChainMessage(jeId, chain));
  const n = String(je?.entry_number ?? jeId);
  if (!chain?.standing) {
    if (verb === 'reverse') return true;
    throw new BankAllocationRefusal(`This bank line is still linked to provisional journal ${n}, which the GL has `
      + 'already reversed. Reverse the line on the bank screen: that frees it and clears the link.');
  }
  const why = `${VERBING[verb]} the line would leave that cash booked with the line free to be allocated again.`;
  if (je?.needs_evidence === true) {
    throw new BankAllocationRefusal(`This bank line is booked by provisional journal ${n}, which still stands in the GL. `
      + `${why} Dismiss the provisional first (Provisional Entries, /accounting/bank/provisional): that reverses `
      + `journal ${n} and frees this line.`);
  }
  throw new BankAllocationRefusal(`This bank line is booked by provisional journal ${n}, evidenced by a captured `
    + `document. ${why} To undo it, approve the supplier bill captured from that document — approving settles the `
    + `provisional with it — then use ${UNAPPLY_REMEDY}, and void the payment: that reverses the provisional and `
    + 'frees this line.');
}
