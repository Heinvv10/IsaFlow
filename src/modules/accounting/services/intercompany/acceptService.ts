/**
 * Accepting an intercompany message (P2), as the RECEIVER, in the receiver's own request (or, for auto-accept, in the worker's
 * transaction opened as the receiver: its claims, its company, its RLS). Accept creates a DRAFT supplier invoice / supplier
 * credit note in this company from the sender's snapshot, marks the message accepted with that document, and records the
 * mirror link (and, for a group pair, marks the sender's elimination row matched). Nothing is posted or approved.
 *
 * Everything below runs in ONE savepoint, so a refusal (answered 4xx, which a request would otherwise commit) leaves no draft,
 * no half-accepted message and no link. The message row is locked first, so a double click or the worker and a person at the
 * same time cannot create two drafts; a second accept finds the message handled. A duplicate (same supplier and number) is
 * refused before anything is written.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { acceptBlockers } from './acceptBlockers';
import {
  accountOptions, accountsUsable, findDuplicate, loadAcceptSide, resolveCreditNoteAccount, resolveLineAccounts, type AcceptSide,
} from './acceptContext';
import { copySenderPdf, createDraftBill, createDraftSupplierCreditNote } from './acceptDocuments';
import { ConnectionRefusal } from './connectionTypes';
import { loadInboxRow, toInboxItem } from './inboxRead';
import { orderLinkDocs } from './linkOrder';
import type { AcceptInput, AcceptResult, InboxDetail, InboxLine } from './inboxTypes';
import { parseMirrorPayload, type MirrorPayload } from './mirrorPayload';
import { mapDraftError } from './mirrorErrors';

type Row = Record<string, unknown>;

/** What the Accept dialog shows: the message, its lines with the account each will use, the supplier, and what blocks Accept. */
export async function previewAccept(companyId: string, messageId: string): Promise<InboxDetail> {
  const row = await loadInboxRow(companyId, messageId);
  if (!row) throw new ConnectionRefusal(404, 'Message not found');
  const item = toInboxItem(row);
  const parsed = parseMirrorPayload(row.payload, item.kind, String(row.from_company_id));
  const side = await loadAcceptSide(companyId, String(row.connection_id));
  const accounts = await accountOptions(companyId);
  if (!parsed.ok || !side) {
    return { item, lines: [], supplier: null, duplicateOf: null, blockers: acceptBlockers(item, parsed.ok ? parsed.payload : null, side, null), accounts };
  }
  const payload = parsed.payload;
  const duplicateOf = await findDuplicate(companyId, side, payload);
  let lines: InboxLine[];
  if (payload.kind === 'invoice') {
    lines = await resolveLineAccounts(companyId, side, payload.lines);
  } else {
    const account = await resolveCreditNoteAccount(companyId, side);
    lines = payload.lines.map((l, index) => ({
      index, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate,
      taxAmount: l.taxAmount, lineTotal: l.lineTotal, accountId: account.id, accountLabel: account.label, accountSource: account.source,
    }));
  }
  return {
    item, lines, supplier: side.supplierId ? { id: side.supplierId, name: side.supplierName ?? '' } : null,
    duplicateOf, blockers: acceptBlockers(item, payload, side, duplicateOf), accounts,
  };
}

/** The accounts the draft will use, one per line (an invoice), or the one the note credits: the person's choice, else the suggestion. */
async function chooseAccounts(companyId: string, side: AcceptSide, payload: MirrorPayload, input: AcceptInput): Promise<string[]> {
  let chosen: string[];
  if (payload.kind === 'invoice') {
    const suggested = await resolveLineAccounts(companyId, side, payload.lines);
    chosen = suggested.map((l) => {
      const account = input.lineAccounts?.[l.index] ?? l.accountId;
      if (!account) throw new ConnectionRefusal(400, `Choose an expense account for line ${l.index + 1}`);
      return account;
    });
    const stray = Object.keys(input.lineAccounts ?? {}).map(Number).find((i) => i >= payload.lines.length);
    if (stray !== undefined) throw new ConnectionRefusal(400, `There is no line ${stray + 1} to choose an account for`);
  } else {
    const account = input.accountId ?? (await resolveCreditNoteAccount(companyId, side)).id;
    if (!account) throw new ConnectionRefusal(400, 'Choose the account this credit note credits');
    chosen = [account];
  }
  // Whoever chose it, an account is THIS company's, active and not a header (the bill's own account rules run again when the draft is written).
  if (!(await accountsUsable(companyId, chosen))) throw new ConnectionRefusal(400, 'One of the chosen accounts cannot be used: it is not one of this company\'s active, postable accounts.');
  return chosen;
}

/** The mirror link: the sender's source document and this company's new document, in the connection's low / high order. */
async function recordLink(messageId: string, row: Row, side: AcceptSide, targetType: string, targetId: string, companyId: string): Promise<string> {
  const senderIsLow = String(row.from_company_id) === side.companyLowId;
  const src = { type: String(row.source_doc_type), id: String(row.source_doc_id) };
  const tgt = { type: targetType, id: targetId };
  const { a, b } = orderLinkDocs(senderIsLow, src, tgt);
  try {
    const rows = (await sql`
      INSERT INTO intercompany_document_links (connection_id, message_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
      VALUES (${side.connectionId}::UUID, ${messageId}::UUID, ${side.companyLowId}::UUID, ${a.type}, ${a.id}::UUID,
              ${side.companyHighId}::UUID, ${b.type}, ${b.id}::UUID, 'mirror')
      RETURNING id
    `) as Row[];
    return String(rows[0]!.id);
  } catch (err) {
    if ((err as { code?: string }).code === '23514' || (err as { code?: string }).code === '23505') {
      throw new ConnectionRefusal(409, 'The sender\'s document is already linked to another document, so this message cannot be accepted.');
    }
    log.error('Intercompany link not written', { companyId, messageId, code: (err as { code?: string }).code ?? null }, 'intercompany');
    throw err;
  }
}

/** The sender's elimination row, marked matched by this company's user (a group pair); the figures it carries are the sender's subtotal. */
async function matchGroupRow(userId: string, companyId: string, payload: MirrorPayload, fromCompanyId: string): Promise<void> {
  if (!payload.groupTransactionId) return;
  await withSavepoint('intercompany_group_match', async () => {
    const rows = (await sql`
      UPDATE intercompany_transactions
         SET match_status = 'matched', variance_amount = 0, matched_at = NOW(), matched_by = ${userId}::UUID
       WHERE id = ${payload.groupTransactionId}::UUID AND source_company_id = ${fromCompanyId}::UUID
         AND target_company_id = ${companyId}::UUID AND match_status = 'unmatched'
       RETURNING id
    `) as Row[];
    if (rows.length === 0) log.warn('Intercompany group row not matched: none to match', { companyId }, 'intercompany');
  }).catch((err: unknown) => {
    log.warn('Intercompany group row not matched', { companyId, code: (err as { code?: string }).code ?? null }, 'intercompany');
  });
}

export interface AcceptOptions {
  /** The worker's accept: needs the side's auto_accept on, and stamps the message `handled_via = 'auto'`. */
  auto?: boolean;
}

export async function acceptMessage(
  userId: string, companyId: string, messageId: string, input: AcceptInput = {}, opts: AcceptOptions = {},
): Promise<AcceptResult> {
  return withSavepoint('intercompany_accept', async () => {
    const row = await loadInboxRow(companyId, messageId, true);
    if (!row) throw new ConnectionRefusal(404, 'Message not found');
    const status = String(row.status);
    if (status === 'accepted' || status === 'rejected') throw new ConnectionRefusal(409, `This message was already ${status}.`);
    if (status === 'dismissed') throw new ConnectionRefusal(409, 'This message was dismissed. Restore it first.');
    const kind = String(row.kind) as 'invoice' | 'credit_note';
    const fromCompanyId = String(row.from_company_id);
    const parsed = parseMirrorPayload(row.payload, kind, fromCompanyId);
    const side = await loadAcceptSide(companyId, String(row.connection_id));
    const duplicate = parsed.ok && side ? await findDuplicate(companyId, side, parsed.payload) : null;
    const blockers = acceptBlockers(toInboxItem(row), parsed.ok ? parsed.payload : null, side, duplicate, opts.auto === true);
    if (blockers.length > 0 || !parsed.ok || !side) throw new ConnectionRefusal(409, blockers[0] ?? 'This message cannot be accepted.');
    const payload = parsed.payload;
    if (side.kind === 'group') {
      // The membership re-check at action time, on the helper the whole protocol uses (it holds the pair's company locks to commit).
      const grouped = (await sql`SELECT public.intercompany_in_one_group(${side.companyLowId}::UUID, ${side.companyHighId}::UUID) AS ok`) as Row[];
      if (grouped[0]?.ok !== true) throw new ConnectionRefusal(409, 'The two companies are no longer in one group, so this message cannot be accepted.');
    }

    const accounts = await chooseAccounts(companyId, side, payload, input);
    const actor = opts.auto ? { actorType: 'system' as const } : undefined;
    let target: { type: 'supplier_invoice' | 'credit_note'; id: string };
    let pdfCopied = false;
    try {
      if (payload.kind === 'invoice') {
        const id = await createDraftBill(companyId, userId, side, payload, accounts, { actor });
        target = { type: 'supplier_invoice', id };
        if (payload.pdf) pdfCopied = await copySenderPdf(companyId, fromCompanyId, userId, id, payload.number, payload.pdf);
      } else {
        target = { type: 'credit_note', id: await createDraftSupplierCreditNote(companyId, userId, side, payload, accounts[0]!, { actor }) };
      }
    } catch (err) {
      throw mapDraftError(err);
    }

    if (opts.auto) await sql`SELECT set_config('app.intercompany_handled_via', 'auto', true)`;
    const updated = (await sql`
      UPDATE intercompany_messages
         SET status = 'accepted', target_doc_type = ${target.type}, target_doc_id = ${target.id}::UUID, error = NULL
       WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND status IN ('pending', 'failed')
       RETURNING id
    `) as Row[];
    if (opts.auto) await sql`SELECT set_config('app.intercompany_handled_via', '', true)`;
    if (updated.length === 0) throw new ConnectionRefusal(409, 'This message was handled by someone else.');

    const linkId = await recordLink(messageId, row, side, target.type, target.id, companyId);
    if (side.kind === 'group') await matchGroupRow(userId, companyId, payload, fromCompanyId);
    log.info('Intercompany message accepted', { companyId, messageId, targetType: target.type, targetId: target.id, auto: opts.auto === true }, 'intercompany');
    return { messageId, targetDocType: target.type, targetDocId: target.id, linkId, pdfCopied };
  });
}
