/**
 * The SENDER's outbox (intercompany P2): when a customer invoice or customer credit note is approved for a customer that is
 * the partner on an ACTIVE intercompany connection, and its date is on or after the connection's cut-over, one message is
 * written for the partner. MESSAGES ONLY: the sender never writes into the other company's ledger, and never reads it.
 *
 * The message is written by the DATABASE (`intercompany_send_for_source`, migration 1013): it reads the approved document, its lines,
 * the company's name, VAT number and currency, builds the payload and the sender's group row (the elimination feed) itself, and
 * the messages guard refuses the sender's own INSERT of a document message. This service names the document and nothing else, so no
 * field of what the receiver reads is the sender's to choose.
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
import type { MirrorKind } from './mirrorPayload';

export type MirrorOutcome =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'no_connection' | 'before_cutover' | 'no_cutover' | 'already_sent' | 'not_found' | 'not_approved' | 'forbidden' | 'unmirrorable' | 'failed' };

const SOURCE_TYPE: Record<MirrorKind, string> = { invoice: 'customer_invoice', credit_note: 'credit_note' };
const REASONS = new Set(['no_connection', 'before_cutover', 'no_cutover', 'already_sent', 'not_found', 'not_approved', 'forbidden', 'unmirrorable']);

type Row = Record<string, unknown>;

async function send(companyId: string, kind: MirrorKind, sourceId: string): Promise<MirrorOutcome> {
  const rows = (await sql`
    SELECT message_id, reason, detail FROM public.intercompany_send_for_source(${SOURCE_TYPE[kind]}, ${sourceId}::UUID)
  `) as Row[];
  const r = rows[0];
  if (r?.message_id) {
    log.info('Intercompany message sent', { companyId, kind, sourceId, messageId: String(r.message_id) }, 'intercompany');
    return { sent: true, messageId: String(r.message_id) };
  }
  const reason = String(r?.reason ?? 'failed');
  if (reason === 'unmirrorable') {
    // A document the receiver's parser would refuse (an imported one with a negative line, a header VAT that is not the rate on its lines)
    // is not sent: the sender's operator finds it in this log (and, in P5, in the reconciliation's list of unsent documents).
    log.error('Intercompany document cannot be mirrored: the receiver could not read it', { companyId, kind, sourceId, reason: String(r?.detail ?? '') }, 'intercompany');
  } else if (reason === 'forbidden' || reason === 'not_approved') {
    log.warn('Intercompany message not sent', { companyId, kind, sourceId, reason }, 'intercompany');
  }
  return { sent: false, reason: REASONS.has(reason) ? (reason as Exclude<MirrorOutcome, { sent: true }>['reason']) : 'failed' };
}

async function guarded(companyId: string, kind: MirrorKind, sourceId: string): Promise<MirrorOutcome> {
  try {
    return await withSavepoint('intercompany_outbox', () => send(companyId, kind, sourceId));
  } catch (err) {
    // Never the approval's failure; the code, not the message text, goes to the log (a database message names ids). AT ERROR: nothing re-sends
    // a message that failed here (a re-send is P5's reconciliation, which lists the unsent documents), so this line is how it is found.
    log.error('Intercompany message not sent', { companyId, kind, sourceId, code: (err as { code?: string })?.code ?? null }, 'intercompany');
    return { sent: false, reason: 'failed' };
  }
}

/** After a customer invoice was approved (and its PDF sealed): the message for its partner company, if it has one. */
export const mirrorApprovedInvoice = (companyId: string, invoiceId: string): Promise<MirrorOutcome> => guarded(companyId, 'invoice', invoiceId);

/** After a customer credit note was approved: the message for its partner company, if it has one. */
export const mirrorApprovedCreditNote = (companyId: string, creditNoteId: string): Promise<MirrorOutcome> => guarded(companyId, 'credit_note', creditNoteId);
