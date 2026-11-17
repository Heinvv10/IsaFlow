/**
 * MCP read tool: `list_documents` (the two document stores). Split from documents.ts (300-line cap), which
 * re-exports it.
 *
 * Paging: both stores answer `next_offset` (null on the last page). The bank store (date range, or one line) pages
 * by offset over a total order (created_at, id); the entity store pages its direct and cross-linked documents
 * independently, so a page can hold up to twice the limit and `next_offset` says whether either side has more.
 * `detail: "summary"` totals the bank store over the WHOLE window without rows; one entity's documents are never
 * large, so a summary of the entity store is refused rather than faked.
 */
import { listSettledDocuments, settledDocumentWire } from '@/modules/accounting/services/bank/settledDocumentService';
import type { McpTool, McpToolResult } from '../types';
import {
  listBankAttachments,
  listEntityDocuments,
} from '@/modules/accounting/services/core/documentQueryService';
import {
  DOCUMENT_ENTITY_TYPES, bankTxBelongsToCompany, isBankEntityType,
} from '@/modules/accounting/services/core/bankLineDocumentRouting';
import {
  BANK_DOCUMENT_GROUP_BY,
  summariseBankAttachments,
} from '@/modules/accounting/services/core/bankAttachmentSummaryService';
import { buildEnvelope } from '../contracts';
import { insufficientScopeMessage } from '../scopeRemediation';
import {
  NOT_FOUND, clampLimit, guardCastableArgs, ok, safeErrorText, strArg, toolError,
} from './toolHelpers';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';
import { SUMMARY_DETAIL_SCHEMA, groupBySchema, parseSummaryRequest, summaryBody } from './summaryMode';

/**
 * A row is about 470 bytes of JSON, and the entity store answers up to TWICE the limit, so 75 keeps the worst case
 * under a client's ~90 KB result limit.
 */
export const DOCUMENTS_DEFAULT_LIMIT = 50;
export const DOCUMENTS_MAX_LIMIT = 75;
/** Settled documents on a bank line's first page; the rest are counted (settled_documents_total), not listed. */
export const SETTLED_DOCUMENTS_MCP_MAX = 20;
const EPOCH = new Date(0).toISOString();
const SUMMARY_BANK_ONLY = 'detail "summary" and group_by cover the bank store (from and to); one entity\'s documents are listed directly: omit them';

/** entity_type bank_transaction: the line's documents from the bank store, ids that get_document accepts. */
async function listBankLineEntity(bankTxId: string, limit: number, offset: number, companyId: string): Promise<McpToolResult> {
  try {
    // BEFORE the read: an empty page must not be what a foreign line looks like.
    if (!(await bankTxBelongsToCompany(companyId, bankTxId))) return toolError(NOT_FOUND);
    const page = await listBankAttachments(companyId, { bankTransactionId: bankTxId, limit, offset });
    // The first page also carries the documents of what the line settles (read-only, not the line's own documents),
    // at most SETTLED_DOCUMENTS_MCP_MAX of them so the worst page stays under the result limit (readLimitsSize).
    const settledAll = offset === 0 ? await listSettledDocuments(companyId, bankTxId) : undefined;
    const settled = settledAll && {
      settled_documents: settledAll.slice(0, SETTLED_DOCUMENTS_MCP_MAX).map(settledDocumentWire),
      settled_documents_total: settledAll.length,
      settled_documents_truncated: settledAll.length > SETTLED_DOCUMENTS_MCP_MAX,
    };
    return ok({ ...buildEnvelope({
      rows: page.rows.map((r) => ({
        store: r.store,
        id: r.id,
        entity_type: 'bank_transaction',
        entity_id: r.bankTransactionId,
        bank_transaction_id: r.bankTransactionId,
        file_name: r.fileName,
        file_size: r.fileSize,
        uploaded_by: r.uploadedBy,
        uploaded_at: r.createdAt,
        transaction_date: r.transactionDate,
        amount: r.amount,
        transaction_description: r.transactionDescription,
        reference: r.reference,
      })),
      rowsTotal: page.rowsTotal,
      detail: 'standard',
      as_at: page.rows[0]?.transactionDate ?? EPOCH.slice(0, 10),
      posted_through: page.postedThrough,
    }), next_offset: nextOffsetFromTotal(offset, page.rows.length, page.rowsTotal),
    ...(settled ?? {}) });
  } catch (err) {
    return toolError(safeErrorText(err, 'Failed to list documents.'));
  }
}
export const listDocumentsTool: McpTool = {
  name: 'list_documents',
  description:
    'Supporting documents on file. THERE ARE TWO SEPARATE STORES and this reads whichever one you address. ' +
    'Give from and to (and optionally bank_transaction_id) to list the receipts, slips and invoice scans attached to BANK TRANSACTIONS — the read side of attach_document (needs read:bank-tx as well as read:reports). ' +
    'Those rows carry store "bank_attachment" (an uploaded file) or "captured_document" (a captured document linked to the bank line that has no uploaded copy, e.g. one over 2 MB); both count as the line\'s supporting documents. ' +
    'Give entity_type and entity_id instead to list the documents filed against one accounting document (' + DOCUMENT_ENTITY_TYPES.join(', ') + '), including documents cross-linked from another entity, which come back with source "linked" and a link_reason. entity_type bank_transaction with the line\'s id lists that one line\'s documents from the bank store (rows as above, no date range needed; needs read:bank-tx as well), so a caller never has to know which store holds what. On the first page it also returns settled_documents: the documents of the bills / invoices (and credit notes applied to them) the line\'s payment settles, each with source "settled_document", via (the payment and its number) and settles (the bill or invoice number, its total, the amount this payment applied and partial: true while the bill is still open after every payment and credit note; at most 20, with settled_documents_total and settled_documents_truncated). Those are evidence, not the line\'s own documents: they are not in rows and get_document does not serve them. ' +
    'DOES NOT COVER: a company-wide listing of the entity store. Those rows carry no company id and are fenced by their parent document, so they can only be read one entity at a time — there is no "all documents for this company" query, and asking for one would silently cross tenants. ' +
    'Nor does it return file bytes; use get_document for a single file. ' +
    'To find what has NO document, use list_unsupported_transactions — an empty page here means nothing was found for what you asked, not that nothing exists. ' +
    `Paging: up to limit documents per call (default ${DOCUMENTS_DEFAULT_LIMIT}, max ${DOCUMENTS_MAX_LIMIT}); the reply carries next_offset, null on the last page, else call again with offset=next_offset. The entity store pages its direct and cross-linked documents side by side, so a page can hold up to twice the limit. ` +
    'To size the bank store without paging, use detail="summary" (count and file_size in bytes over the WHOLE from/to window, no rows) and group_by=store|month (groups sum to the totals). A summary takes no offset and is for the bank store only; one entity\'s documents are listed directly.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Transaction date from, YYYY-MM-DD. Bank store only.' },
      to: { type: 'string', description: 'Transaction date to, YYYY-MM-DD. Bank store only.' },
      bank_transaction_id: { type: 'string', description: 'Narrows the bank store to one transaction.' },
      entity_type: { type: 'string', enum: [...DOCUMENT_ENTITY_TYPES] },
      entity_id: { type: 'string', description: 'With entity_type, reads the entity store instead.' },
      limit: { type: 'integer', minimum: 1, maximum: DOCUMENTS_MAX_LIMIT, description: `Default ${DOCUMENTS_DEFAULT_LIMIT}, max ${DOCUMENTS_MAX_LIMIT}` },
      offset: OFFSET_SCHEMA,
      detail: SUMMARY_DETAIL_SCHEMA,
      group_by: groupBySchema(BANK_DOCUMENT_GROUP_BY),
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const entityType = strArg(args, 'entity_type');
    const entityId = strArg(args, 'entity_id');
    const limit = clampLimit(args, DOCUMENTS_DEFAULT_LIMIT, DOCUMENTS_MAX_LIMIT);
    const wanted = parseSummaryRequest(args, BANK_DOCUMENT_GROUP_BY);
    if (!wanted.ok) return wanted.error;
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);

    if (entityType !== undefined || entityId !== undefined) {
      if (!entityType || !entityId) return toolError('entity_type and entity_id must be given together');
      if (wanted.summary) return toolError(SUMMARY_BANK_ONLY);
      const bad = guardCastableArgs(args, { uuid: ['entity_id'] });
      if (bad) return bad;
      if (isBankEntityType(entityType)) {
        // Same read scope as list_missing_documents' bank_transaction type.
        if (!ctx.scopes.includes('read:bank-tx')) return toolError(insufficientScopeMessage('read:bank-tx'));
        return listBankLineEntity(entityId, limit, offset, ctx.companyId);
      }
      try {
        const result = await listEntityDocuments(ctx.companyId, entityType, entityId, limit, offset);
        if (!result.ok) {
          // Cross-tenant and genuine miss must read identically.
          return result.reason === 'invalid_entity_type'
            ? toolError(`invalid entity_type — expected one of: ${DOCUMENT_ENTITY_TYPES.join(', ')}`)
            : toolError(NOT_FOUND);
        }
        const rows = result.documents.map((d) => ({
          store: 'entity_document',
          id: d.id,
          entity_type: d.entityType,
          entity_id: d.entityId,
          document_type: d.documentType,
          file_name: d.documentName,
          file_size: d.fileSize ?? null,
          mime_type: d.mimeType ?? null,
          uploaded_by: d.uploadedByName ?? d.uploadedBy ?? null,
          uploaded_at: d.uploadedAt,
          source: d.source,
          link_reason: d.linkReason ?? null,
        }));
        return ok({ ...buildEnvelope({
          rows,
          // Offset paging over two stores cannot state a total without a third
          // count per store; hasMore is what the underlying endpoint knows.
          rowsTotal: rows.length + (result.hasMore ? 1 : 0),
          detail: 'standard',
          as_at: rows[0]?.uploaded_at?.slice(0, 10) ?? EPOCH.slice(0, 10),
          posted_through: rows.reduce((m, r) => (r.uploaded_at > m ? r.uploaded_at : m), EPOCH),
        }), next_offset: result.hasMore ? offset + limit : null });
      } catch (err) {
        return toolError(safeErrorText(err, 'Failed to list documents.'));
      }
    }

    const from = strArg(args, 'from');
    const to = strArg(args, 'to');
    if (!from || !to) {
      return toolError('from and to are required (YYYY-MM-DD), or give entity_type + entity_id instead');
    }
    // The date-range listing returns bank attachments: the same gate as the bank_transaction entity path.
    if (!ctx.scopes.includes('read:bank-tx')) return toolError(insufficientScopeMessage('read:bank-tx'));
    const bad = guardCastableArgs(args, { date: ['from', 'to'], uuid: ['bank_transaction_id'] });
    if (bad) return bad;
    const line = strArg(args, 'bank_transaction_id');
    const window = { from, to, ...(line === undefined ? {} : { bankTransactionId: line }) };
    try {
      if (wanted.summary) {
        return ok(summaryBody(await summariseBankAttachments(ctx.companyId, window, wanted.groupBy), wanted.groupBy, { from, to }));
      }
      const page = await listBankAttachments(ctx.companyId, { ...window, limit, offset });
      return ok({ ...buildEnvelope({
        rows: page.rows.map((r) => ({
          store: r.store,
          id: r.id,
          bank_transaction_id: r.bankTransactionId,
          file_name: r.fileName,
          file_size: r.fileSize,
          uploaded_by: r.uploadedBy,
          uploaded_at: r.createdAt,
          transaction_date: r.transactionDate,
          amount: r.amount,
          transaction_description: r.transactionDescription,
          reference: r.reference,
        })),
        rowsTotal: page.rowsTotal,
        // No universeTotal: it equalled rowsTotal with nothing excluded, so
        // the completeness check compared a number with itself.
        detail: 'standard',
        as_at: to,
        posted_through: page.postedThrough,
      }), next_offset: nextOffsetFromTotal(offset, page.rows.length, page.rowsTotal) });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to list documents.'));
    }
  },
};
