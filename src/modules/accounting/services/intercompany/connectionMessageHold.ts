/**
 * Intercompany P4-E (j).8: while a connection carries an allocation message that is still unhandled (pending, failed, or dismissed and so
 * restorable) or that was ACCEPTED (the partner cleared it against its loan), the relationship that message stands on may not change under it:
 * unlinking a pairing on the connection, changing its settlement mode, or re-pointing either side's loan account is refused (409) before any
 * write. A rejected or withdrawn message does not hold anything. The row the change writes is locked FIRST (the link, or the connection), so a
 * payment whose allocation message is being sent at the same moment (the sender holds the link and the connection FOR SHARE until its commit)
 * is waited for and then counted. The SAFER reading of the plan: any such message on the CONNECTION holds all three changes, not only the
 * messages naming the link being unlinked. Accepted limit: an accepted message holds them for good (until intercompany reversals, #1772).
 */
import { sql } from '@/lib/neon';
import { ConnectionRefusal } from './connectionTypes';

type Row = Record<string, unknown>;

export type HeldChange = 'unlink' | 'settlement_mode' | 'loan_account';

const WHAT: Readonly<Record<HeldChange, string>> = Object.freeze({
  unlink: 'its pairings cannot be unlinked',
  settlement_mode: 'its settlement mode cannot change',
  loan_account: 'its loan accounts cannot be changed',
});

export const heldSentence = (change: HeldChange): string =>
  `This connection carries an intercompany allocation message that is still open or was accepted (a payment cleared, or to be cleared, against the loan), so ${WHAT[change]}. Handle the message first (the partner rejects it, or it is cleared); an accepted one keeps the connection as it is until intercompany reversals exist.`;

/** Lock the link FOR UPDATE (an unlink), then refuse while the connection holds an open or accepted allocation message. */
export async function lockLinkAndRefuseWhileHeld(companyId: string, connectionId: string, linkId: string): Promise<void> {
  await sql`
    SELECT k.id FROM intercompany_document_links k
     WHERE k.id = ${linkId}::UUID AND k.connection_id = ${connectionId}::UUID
       AND (k.company_a_id = ${companyId}::UUID OR k.company_b_id = ${companyId}::UUID)
       FOR UPDATE
  `;
  await refuseWhileHeld(companyId, connectionId, 'unlink');
}

/** Lock the connection (no key update: the settings write, or the side write that hangs off it), then refuse while it is held. */
export async function lockConnectionAndRefuseWhileHeld(companyId: string, connectionId: string, change: HeldChange): Promise<void> {
  await sql`
    SELECT c.id FROM intercompany_connections c
     WHERE c.id = ${connectionId}::UUID AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
       FOR NO KEY UPDATE
  `;
  await refuseWhileHeld(companyId, connectionId, change);
}

async function refuseWhileHeld(companyId: string, connectionId: string, change: HeldChange): Promise<void> {
  const rows = (await sql`
    SELECT 1 AS one FROM intercompany_messages m
     WHERE m.connection_id = ${connectionId}::UUID AND (m.from_company_id = ${companyId}::UUID OR m.to_company_id = ${companyId}::UUID)
       AND m.kind = 'allocation' AND m.status IN ('pending', 'failed', 'dismissed', 'accepted')
     LIMIT 1
  `) as Row[];
  if (rows.length > 0) throw new ConnectionRefusal(409, heldSentence(change));
}
