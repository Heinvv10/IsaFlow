/**
 * The pairing screen's data for one connection and one direction: the suggestions and exceptions (this company's open pre-cut-over
 * documents against the partner's), the pairings already recorded, and the loan-balance difference. Reads only; the partner's side
 * is the definer functions' answer (pairingRead.ts), so a company never reads the partner's ledger.
 */
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { listConnections } from './connectionRead';
import { matchDocuments } from './pairingMatch';
import {
  DOC_LIMIT, MY_TYPE, isInvoicePairing, myDocId, myDocType, readOwnDocsById, readOwnLinks, readOwnLoanBalance, readOwnOpenDocs, readPartnerDocs,
  readPartnerLoanBalance, theirDocId, type LinkRow, type PartnerDoc,
} from './pairingRead';
import { ConnectionRefusal, type ConnectionView } from './connectionTypes';
import type {
  LoanDifference, PairingBlock, PairingDirection, PairingDoc, PairingLinkView, PairingMatches, PairingView,
} from './pairingTypes';

const EMPTY_MATCHES: PairingMatches = { suggestions: [], mismatches: [], unmatchedMine: [], unmatchedTheirs: [], unsupported: [] };
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The day before the cut-over: the last day the loan balances count (YYYY-MM-DD). */
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Why suggestions are not offered, or null. The first reason wins: the person fixes them in this order. */
export function blockReason(conn: ConnectionView, direction: PairingDirection, mayWrite: boolean): PairingBlock | null {
  if (conn.status !== 'active') return 'revoked';
  if (!mayWrite) return 'no_write_access';
  if (!conn.settings.cutoverDate) return 'no_cutover';
  const party = direction === 'ar' ? conn.side?.customerId : conn.side?.supplierId;
  return party ? null : 'no_party';
}

function toLinkView(l: LinkRow, mine: Map<string, PairingDoc>, theirs: Map<string, PartnerDoc>, heldByOthers: Set<string>): PairingLinkView {
  const pending = l.status === 'pending_confirmation';
  const awaiting = !pending ? null : l.confirmedByMe ? 'partner' : 'me';
  return {
    id: l.id,
    status: l.status,
    awaiting,
    // A proposal waiting for this company whose document has since been paired another way can only be declined.
    conflict: awaiting === 'me' && heldByOthers.has(myDocId(l)),
    mine: mine.get(myDocId(l)) ?? null,
    theirs: theirs.get(theirDocId(l)) ?? null,
    createdAt: l.createdAt,
  };
}

async function loanDifference(conn: ConnectionView, companyId: string): Promise<LoanDifference | null> {
  const cutover = conn.settings.cutoverDate;
  const account = conn.side?.loanAccountId;
  if (!cutover || !account) return null;
  const mine = await readOwnLoanBalance(companyId, account, cutover);
  // The definer answers NULL to anyone but a writer on an active connection, so there is no second check here.
  const theirs = await readPartnerLoanBalance(conn.id);
  return { mine, theirs, difference: theirs == null ? null : round2(mine + theirs), asAt: dayBefore(cutover) };
}

export async function buildPairingView(userId: string, companyId: string, connectionId: string, direction: PairingDirection): Promise<PairingView> {
  const [conn] = await listConnections(companyId, connectionId);
  if (!conn) throw new ConnectionRefusal(404, 'Connection not found');
  const mayWrite = await userCanWriteCompany(userId, companyId);
  const blocked = blockReason(conn, direction, mayWrite);
  const confirmsBoth = conn.kind === 'group' && conn.canEditSettings;

  const allLinks = await readOwnLinks(companyId);
  const here = allLinks.filter((l) => l.connectionId === connectionId && isInvoicePairing(l) && myDocType(l) === MY_TYPE[direction]);
  // A pending pairing holds only the side its proposer verified (migration 1002): the partner's proposal naming one of this
  // company's documents does not hold it, so the document stays on offer here. Only a link this company has confirmed does.
  const heldMine = new Set(allLinks.filter((l) => l.status === 'active' || l.confirmedByMe).map(myDocId));
  const namedHere = new Set(here.map(theirDocId));

  const cutover = conn.settings.cutoverDate;
  const partyId = direction === 'ar' ? conn.side?.customerId : conn.side?.supplierId;
  const partner = blocked === null ? await readPartnerDocs(connectionId, direction) : [];
  const own = blocked === null && cutover && partyId ? await readOwnOpenDocs(direction, companyId, partyId, cutover) : [];
  const truncated = partner.length > DOC_LIMIT || own.length > DOC_LIMIT;

  const mineOffered = own.slice(0, DOC_LIMIT).filter((d) => !heldMine.has(d.id));
  const theirsOffered = partner.slice(0, DOC_LIMIT).filter((d) => d.linkId === null && !namedHere.has(d.id));
  const found = blocked === null ? matchDocuments(mineOffered, theirsOffered) : EMPTY_MATCHES;
  // A document the partner has proposed a pairing for is shown under Pairings (to confirm or decline), not as an exception too.
  const proposedToMe = new Set(here.filter((l) => l.status === 'pending_confirmation' && !l.confirmedByMe).map(myDocId));
  const matches: PairingMatches = {
    ...found,
    mismatches: found.mismatches.filter((m) => !proposedToMe.has(m.mine.id)),
    unmatchedMine: found.unmatchedMine.filter((d) => !proposedToMe.has(d.id)),
  };

  const mineById = await readOwnDocsById(direction, companyId, here.map(myDocId));
  const theirsById = new Map(partner.map((d) => [d.id, d]));
  const links = here.map((l) => toLinkView(l, mineById, theirsById, heldMine))
    .sort((a, b) => Number(b.awaiting === 'me') - Number(a.awaiting === 'me') || Number(b.status === 'pending_confirmation') - Number(a.status === 'pending_confirmation'));

  return {
    connectionId, partnerName: conn.partnerName, direction, cutoverDate: cutover, blocked, confirmsBoth, matches, truncated, links,
    loan: await loanDifference(conn, companyId),
  };
}
