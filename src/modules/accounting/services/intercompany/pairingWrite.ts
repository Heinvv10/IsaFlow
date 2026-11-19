/**
 * Writes of the pairing screen: record pairings (document links, origin manual_pairing), confirm the partner's proposal, unlink.
 * NO posting and no GL row is ever written here: a pairing is a fact about two documents. The links table's guards (1000, 1002)
 * are the last line: the inserter's own document must exist in its own company, a pending pairing holds only the verified side
 * (so a partner cannot squat a document by proposing it), a document is in one live link at a time, and only a user with a write
 * role acts. This service checks the same first, so the person is told in a sentence.
 */
import { sql } from '@/lib/neon';
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { listConnections } from './connectionRead';
import { orderedPair } from './connectionValidation';
import { ConnectionRefusal } from './connectionTypes';
import { MY_TYPE, THEIR_TYPE, isInvoicePairing, readOwnLinks } from './pairingRead';
import { buildPairingView } from './pairingView';
import type { PairInput, PairingBlock, PairingDirection, PairingResult } from './pairingTypes';

type Row = Record<string, unknown>;

const BLOCK_REFUSAL: Record<PairingBlock, ConnectionRefusal> = {
  revoked: new ConnectionRefusal(409, 'This connection is revoked, so documents can no longer be paired.'),
  no_write_access: new ConnectionRefusal(403, 'Pairing documents needs an owner, admin or manager role in this company.'),
  no_cutover: new ConnectionRefusal(409, "Set the connection's cut-over date first: only documents dated before it are paired."),
  no_party: new ConnectionRefusal(409, 'Link the customer (or supplier) for this connection first, in "My settings".'),
};
const GONE = new ConnectionRefusal(409, 'One of these pairs is no longer on offer: a document may have been paid, paired or changed. Reload and try again.');

/** The refusal for a database refusal of a link write, or null for anything unexpected (which the caller rethrows). */
export function refusalFor(err: unknown): ConnectionRefusal | null {
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? '';
  if (e.code === '23505' || (e.code === '23514' && msg.includes('one active or pending link'))) {
    return new ConnectionRefusal(409, 'One of these documents is already in another pairing.');
  }
  if (e.code === '23514' && msg.includes('active connection')) return new ConnectionRefusal(409, 'This connection is no longer active.');
  if (e.code === '23514' && msg.includes('already confirmed')) return new ConnectionRefusal(409, 'This pairing is already confirmed on your side.');
  if (e.code === '23514' && msg.includes('not this company')) return new ConnectionRefusal(409, "A document is no longer in this company's books.");
  if (e.code === '42501') return BLOCK_REFUSAL.no_write_access;
  return null;
}

async function mayWriteOrRefuse(userId: string, companyId: string): Promise<void> {
  if (!(await userCanWriteCompany(userId, companyId))) throw BLOCK_REFUSAL.no_write_access;
}

/**
 * Record `pairs` as document links, all or none (one transaction: a database refusal aborts it whole, and the request answers 4xx on a
 * transaction that can no longer commit anything). Each pair must be one the screen SUGGESTS right now (so a document id from
 * anywhere else, a mismatch or an unmatched document is refused, whatever the database would say). A user who can write in BOTH companies of a group confirms both
 * sides at once (the links guard allows it); anyone else's pairing waits for the partner to confirm.
 */
export async function createPairings(userId: string, companyId: string, connectionId: string, direction: PairingDirection, pairs: PairInput[]): Promise<PairingResult> {
  const view = await buildPairingView(userId, companyId, connectionId, direction);
  if (view.blocked) throw BLOCK_REFUSAL[view.blocked];
  const [conn] = await listConnections(companyId, connectionId);
  if (!conn) throw new ConnectionRefusal(404, 'Connection not found');

  // Only the pairs the screen SUGGESTS (same number and total) are recorded: a mismatch or a document with no counterpart is an
  // exception to correct, not a pairing to force. Anything else is refused whatever the database would say.
  const suggested = new Set(view.matches.suggestions.map((c) => `${c.mine.id}|${c.theirs.id}`));
  if (pairs.some((p) => !suggested.has(`${p.mineId}|${p.theirsId}`))) throw GONE;

  const { low, high } = orderedPair(companyId, conn.partnerCompanyId);
  const mineIsA = companyId.toLowerCase() === low;
  const [mineType, theirType] = [MY_TYPE[direction], THEIR_TYPE[direction]];
  let active = 0;
  try {
    for (const p of pairs) {
      const [aType, aId, bType, bId] = mineIsA ? [mineType, p.mineId, theirType, p.theirsId] : [theirType, p.theirsId, mineType, p.mineId];
      const made = (await sql`
        INSERT INTO intercompany_document_links
          (connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
        VALUES (${connectionId}::UUID, ${low}::UUID, ${aType}, ${aId}::UUID, ${high}::UUID, ${bType}, ${bId}::UUID, 'manual_pairing')
        RETURNING id
      `) as Row[];
      if (!view.confirmsBoth) continue;
      const linkId = String(made[0]?.id);
      // The partner's side, confirmed by this same user (a writer in both companies of a group).
      const done = (mineIsA
        ? await sql`UPDATE intercompany_document_links SET confirmed_by_b = ${userId} WHERE id = ${linkId}::UUID AND status = 'pending_confirmation' RETURNING status`
        : await sql`UPDATE intercompany_document_links SET confirmed_by_a = ${userId} WHERE id = ${linkId}::UUID AND status = 'pending_confirmation' RETURNING status`) as Row[];
      if (done[0]?.status === 'active') active += 1;
    }
  } catch (err) {
    const known = refusalFor(err);
    if (known) throw known;
    throw err;
  }
  return { created: pairs.length, active };
}

async function ownLink(companyId: string, connectionId: string, linkId: string) {
  // Another origin's link (a mirror made by P2) or a credit-note link is not a pairing of this screen: a 404, never touched.
  const link = (await readOwnLinks(companyId)).find((l) => l.id === linkId && l.connectionId === connectionId && isInvoicePairing(l));
  if (!link) throw new ConnectionRefusal(404, 'Pairing not found');
  return link;
}

/** Confirm a pairing the partner proposed (this company's side). It becomes active; nothing is posted. */
export async function confirmPairing(userId: string, companyId: string, connectionId: string, linkId: string): Promise<{ status: string }> {
  await mayWriteOrRefuse(userId, companyId);
  const link = await ownLink(companyId, connectionId, linkId);
  if (link.status === 'active' || link.confirmedByMe) throw new ConnectionRefusal(409, 'This pairing is already confirmed on your side.');
  try {
    const done = (link.mineIsA
      ? await sql`UPDATE intercompany_document_links SET confirmed_by_a = ${userId} WHERE id = ${linkId}::UUID AND status = 'pending_confirmation' RETURNING status`
      : await sql`UPDATE intercompany_document_links SET confirmed_by_b = ${userId} WHERE id = ${linkId}::UUID AND status = 'pending_confirmation' RETURNING status`) as Row[];
    if (!done[0]) throw new ConnectionRefusal(409, 'This pairing was changed meanwhile. Reload and try again.');
    return { status: String(done[0].status) };
  } catch (err) {
    const known = refusalFor(err);
    if (known) throw known;
    throw err;
  }
}

/** Either party ends a pairing (pending or active). The two documents become pairable again. Nothing is posted or reversed. */
export async function unlinkPairing(userId: string, companyId: string, connectionId: string, linkId: string): Promise<{ status: string }> {
  await mayWriteOrRefuse(userId, companyId);
  await ownLink(companyId, connectionId, linkId);
  try {
    const done = (await sql`
      UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = ${linkId}::UUID AND status <> 'unlinked' RETURNING status
    `) as Row[];
    if (!done[0]) throw new ConnectionRefusal(409, 'This pairing was already removed.');
    return { status: String(done[0].status) };
  } catch (err) {
    const known = refusalFor(err);
    if (known) throw known;
    throw err;
  }
}
