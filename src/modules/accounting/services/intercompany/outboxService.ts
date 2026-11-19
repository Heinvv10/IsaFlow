/**
 * The SENDER's outbox (intercompany P2): when a customer invoice or customer credit note is approved for a customer that is
 * the partner on an ACTIVE intercompany connection, and its date is on or after the connection's cut-over, one message is
 * written for the partner. MESSAGES ONLY: the sender writes its own outbox row (and, for a GROUP pair, its own side of the
 * group's `intercompany_transactions`); it never writes into the other company's ledger, and it never reads it.
 *
 * Called from `approveCustomerInvoice` and `approveCreditNote`, on the approval's own transaction (so the message commits or
 * rolls back with the approval), inside a SAVEPOINT: a mirror that cannot be written (a refusal by the database, a viewer
 * who approved, a revoked connection) is logged and never fails or poisons the approval. A re-approval, a retry or a second
 * call writes no second message (UNIQUE from company + source type + source id + kind, and an existence check first, so the
 * group row is not written twice either).
 *
 * A foreign-currency document is still sent (the receiver then refuses it with a plain sentence and can reject it with a
 * reason, which comes back); only the receiver's accept is ZAR-only.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { buildCreditNotePayload, buildInvoicePayload, type MirrorKind, type MirrorPayload } from './mirrorPayload';
import { readCreditNoteSource, readInvoiceSource, routeForDocument, type OutboxRoute } from './outboxRead';

export type MirrorOutcome =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'no_connection' | 'before_cutover' | 'no_cutover' | 'already_sent' | 'not_found' | 'failed' };

const SOURCE_TYPE: Record<MirrorKind, string> = { invoice: 'customer_invoice', credit_note: 'credit_note' };

type Row = Record<string, unknown>;

/** The active group both companies are in, as the sender can establish it (its own membership, and the definer parties check). */
async function sharedGroupId(senderId: string, partnerId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT g.id
      FROM company_group_members me
      JOIN company_groups g ON g.id = me.group_id AND g.is_active IS NOT FALSE
     WHERE me.company_id = ${senderId}::UUID AND me.left_date IS NULL
       AND public.rls_intercompany_parties_ok(g.id, ${senderId}::UUID, ${partnerId}::UUID, NULL, NULL)
     ORDER BY g.created_at, g.id
     LIMIT 1
  `) as Row[];
  return rows[0] ? String(rows[0].id) : null;
}

/** The sender's side of the group's elimination feed: one 'sale' row, unmatched until the receiver accepts (a credit note is negative). */
async function recordGroupSide(
  senderId: string, route: OutboxRoute, kind: MirrorKind, payload: MirrorPayload, journalEntryId: string | null,
): Promise<string | null> {
  const groupId = await sharedGroupId(senderId, route.partnerCompanyId);
  if (!groupId) return null;
  const amount = kind === 'credit_note' ? -payload.subtotal : payload.subtotal;
  const rows = (await sql`
    INSERT INTO intercompany_transactions (
      group_id, source_company_id, target_company_id, source_journal_entry_id,
      transaction_type, amount, currency, description, transaction_date
    ) VALUES (
      ${groupId}::UUID, ${senderId}::UUID, ${route.partnerCompanyId}::UUID, ${journalEntryId}::UUID,
      'sale', ${amount}, 'ZAR', ${`${kind === 'invoice' ? 'Invoice' : 'Credit note'} ${payload.number} (mirrored)`}, ${payload.date}::DATE
    ) RETURNING id
  `) as Row[];
  return String(rows[0]!.id);
}

async function send(
  companyId: string, kind: MirrorKind, sourceId: string,
  read: () => Promise<{ payload: MirrorPayload; journalEntryId: string | null } | null>,
): Promise<MirrorOutcome> {
  // The cheap answer first: nearly every approval is for a customer with no connection, and costs this one query.
  const route = await routeForDocument(companyId, kind, sourceId);
  if (!route) return { sent: false, reason: 'no_connection' };
  // No cut-over agreed: nothing is mirrored (the checklist asks for one). Before it: the pairing screen's business, not a message.
  if (!route.cutoverDate) return { sent: false, reason: 'no_cutover' };
  if (route.documentDate < route.cutoverDate) return { sent: false, reason: 'before_cutover' };

  const existing = (await sql`
    SELECT id FROM intercompany_messages
     WHERE from_company_id = ${companyId}::UUID AND source_doc_type = ${SOURCE_TYPE[kind]} AND source_doc_id = ${sourceId}::UUID AND kind = ${kind}
  `) as Row[];
  if (existing.length > 0) return { sent: false, reason: 'already_sent' };

  const source = await read();
  if (!source) return { sent: false, reason: 'not_found' };
  const payload = { ...source.payload };
  if (route.kind === 'group') {
    // The elimination feed is secondary: if its row cannot be written the message is still sent (and carries no reference).
    payload.groupTransactionId = await withSavepoint('intercompany_group_row',
      () => recordGroupSide(companyId, route, kind, payload, source.journalEntryId)).catch((err: unknown) => {
      log.warn('Intercompany group row not written', { companyId, kind, sourceId, code: (err as { code?: string })?.code ?? null }, 'intercompany');
      return null;
    });
  }
  const inserted = (await sql`
    INSERT INTO intercompany_messages (connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
    VALUES (${route.connectionId}::UUID, ${companyId}::UUID, ${route.partnerCompanyId}::UUID, ${kind}, ${SOURCE_TYPE[kind]},
            ${sourceId}::UUID, ${JSON.stringify(payload)}::JSONB)
    ON CONFLICT (from_company_id, source_doc_type, source_doc_id, kind) DO NOTHING
    RETURNING id
  `) as Row[];
  if (inserted.length === 0) return { sent: false, reason: 'already_sent' };
  const messageId = String(inserted[0]!.id);
  log.info('Intercompany message sent', { companyId, kind, sourceId, messageId, connectionId: route.connectionId }, 'intercompany');
  return { sent: true, messageId };
}

async function guarded(companyId: string, kind: MirrorKind, sourceId: string, run: () => Promise<MirrorOutcome>): Promise<MirrorOutcome> {
  try {
    return await withSavepoint('intercompany_outbox', run);
  } catch (err) {
    // Never the approval's failure; the code, not the message text, goes to the log (a database message names ids).
    log.warn('Intercompany message not sent', { companyId, kind, sourceId, code: (err as { code?: string })?.code ?? null }, 'intercompany');
    return { sent: false, reason: 'failed' };
  }
}

/** After a customer invoice was approved (and its PDF sealed): the message for its partner company, if it has one. */
export function mirrorApprovedInvoice(companyId: string, invoiceId: string): Promise<MirrorOutcome> {
  return guarded(companyId, 'invoice', invoiceId, () => send(companyId, 'invoice', invoiceId, async () => {
    const s = await readInvoiceSource(companyId, invoiceId);
    return s && { payload: buildInvoicePayload(s), journalEntryId: s.glJournalEntryId };
  }));
}

/** After a customer credit note was approved: the message for its partner company, if it has one. */
export function mirrorApprovedCreditNote(companyId: string, creditNoteId: string): Promise<MirrorOutcome> {
  return guarded(companyId, 'credit_note', creditNoteId, () => send(companyId, 'credit_note', creditNoteId, async () => {
    const s = await readCreditNoteSource(companyId, creditNoteId);
    return s && { payload: buildCreditNotePayload(s), journalEntryId: s.glJournalEntryId };
  }));
}
