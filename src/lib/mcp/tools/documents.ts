/**
 * MCP read tools for the document stores: list_documents, get_document and
 * list_unsupported_transactions.
 *
 * attach_document and the documents upload endpoint both write and nothing
 * read them back, which is why "which transactions over R10,000 have no
 * supporting document" — a standard audit test — has been unanswerable.
 */
import type { McpTool } from '../types';
import {
  listBankAttachments,
  listEntityDocuments,
  listTransactionsWithoutDocuments,
} from '@/modules/accounting/services/core/documentQueryService';
import { getBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { VALID_ENTITY_TYPES } from '@/modules/accounting/services/core/documentStorageService';
import { buildEnvelope } from '../contracts';
import {
  NOT_FOUND, clampLimit, guardCastableArgs, ok, safeErrorText, strArg, toolError,
} from './toolHelpers';

const MAX_LIMIT = 200;
const EPOCH = new Date(0).toISOString();

export const listDocumentsTool: McpTool = {
  name: 'list_documents',
  description:
    'Supporting documents on file. THERE ARE TWO SEPARATE STORES and this reads whichever one you address. ' +
    'Give from and to (and optionally bank_transaction_id) to list the receipts, slips and invoice scans attached to BANK TRANSACTIONS — the read side of attach_document. ' +
    'Give entity_type and entity_id instead to list the documents filed against one accounting document (' + VALID_ENTITY_TYPES.join(', ') + '), including documents cross-linked from another entity, which come back with source "linked" and a link_reason. ' +
    'DOES NOT COVER: a company-wide listing of the entity store. Those rows carry no company id and are fenced by their parent document, so they can only be read one entity at a time — there is no "all documents for this company" query, and asking for one would silently cross tenants. ' +
    'Nor does it return file bytes; use get_document for a single file. ' +
    'To find what has NO document, use list_unsupported_transactions — an empty page here means nothing was found for what you asked, not that nothing exists.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Transaction date from, YYYY-MM-DD. Bank store only.' },
      to: { type: 'string', description: 'Transaction date to, YYYY-MM-DD. Bank store only.' },
      bank_transaction_id: { type: 'string', description: 'Narrows the bank store to one transaction.' },
      entity_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
      entity_id: { type: 'string', description: 'With entity_type, reads the entity store instead.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      offset: { type: 'integer', minimum: 0, description: 'Entity store only.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const entityType = strArg(args, 'entity_type');
    const entityId = strArg(args, 'entity_id');
    const limit = clampLimit(args, 50, MAX_LIMIT);

    if (entityType !== undefined || entityId !== undefined) {
      if (!entityType || !entityId) return toolError('entity_type and entity_id must be given together');
      const bad = guardCastableArgs(args, { uuid: ['entity_id'] });
      if (bad) return bad;
      const offset = Number.isFinite(Number(args.offset)) ? Math.max(0, Math.floor(Number(args.offset))) : 0;
      try {
        const result = await listEntityDocuments(ctx.companyId, entityType, entityId, limit, offset);
        if (!result.ok) {
          // Cross-tenant and genuine miss must read identically.
          return result.reason === 'invalid_entity_type'
            ? toolError(`invalid entity_type — expected one of: ${VALID_ENTITY_TYPES.join(', ')}`)
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
        return ok(buildEnvelope({
          rows,
          // Offset paging over two stores cannot state a total without a third
          // count per store; hasMore is what the underlying endpoint knows.
          rowsTotal: rows.length + (result.hasMore ? 1 : 0),
          detail: 'standard',
          as_at: rows[0]?.uploaded_at?.slice(0, 10) ?? EPOCH.slice(0, 10),
          posted_through: rows.reduce((m, r) => (r.uploaded_at > m ? r.uploaded_at : m), EPOCH),
        }));
      } catch (err) {
        return toolError(safeErrorText(err, 'Failed to list documents.'));
      }
    }

    const from = strArg(args, 'from');
    const to = strArg(args, 'to');
    if (!from || !to) {
      return toolError('from and to are required (YYYY-MM-DD), or give entity_type + entity_id instead');
    }
    const bad = guardCastableArgs(args, { date: ['from', 'to'], uuid: ['bank_transaction_id'] });
    if (bad) return bad;
    try {
      const page = await listBankAttachments(ctx.companyId, {
        from, to, limit,
        ...(strArg(args, 'bank_transaction_id') === undefined
          ? {} : { bankTransactionId: strArg(args, 'bank_transaction_id')! }),
      });
      return ok(buildEnvelope({
        rows: page.rows.map((r) => ({
          store: 'bank_attachment',
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
      }));
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to list documents.'));
    }
  },
};

export const listUnsupportedTransactionsTool: McpTool = {
  name: 'list_unsupported_transactions',
  description:
    'Bank transactions with NO supporting document attached — the "which transactions over R10,000 have no receipt" audit test. ' +
    'min_amount is compared against the ABSOLUTE amount, so a R12,000 payment out is caught as readily as one in. Rows come back largest first. ' +
    'transactions_in_scope is every transaction in the range over the threshold; transactions_with_a_document is how many of those do have one, so the two figures size the exposure rather than merely listing it. ' +
    'LIMIT: "supporting document" here means a file attached to the BANK TRANSACTION itself (attach_document). A transaction whose evidence was filed against the related invoice instead is still reported as unsupported — those two stores are not linked. Treat the result as a list to check, not a list of failures.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Transaction date from, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Transaction date to, YYYY-MM-DD.' },
      min_amount: { type: 'number', minimum: 0, description: 'Materiality threshold on ABS(amount). Default 0 — everything.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const from = strArg(args, 'from');
    const to = strArg(args, 'to');
    if (!from || !to) return toolError('from and to are required, formatted YYYY-MM-DD');
    const bad = guardCastableArgs(args, { date: ['from', 'to'] });
    if (bad) return bad;
    const raw = args.min_amount;
    if (raw !== undefined && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      return toolError('min_amount must be a number of 0 or more — it is compared against the absolute amount');
    }
    const minAmount = raw === undefined ? 0 : Number(raw);
    try {
      const page = await listTransactionsWithoutDocuments(ctx.companyId, {
        from, to, minAmount, limit: clampLimit(args, 50, MAX_LIMIT),
      });
      const envelope = buildEnvelope({
        rows: page.rows.map((r) => ({
          transaction_id: r.id,
          transaction_date: r.transactionDate,
          amount: r.amount,
          description: r.description,
          reference: r.reference,
          status: r.status,
        })),
        rowsTotal: page.rowsTotal,
        detail: 'standard',
        as_at: to,
        posted_through: page.postedThrough,
      });
      // Not universeTotal: the rows this report EXCLUDES are the supported
      // transactions, which are a correct outcome and not an excludedRows
      // entry. Reporting both counts says the same thing without asking
      // buildEnvelope to check an identity that does not hold here.
      return ok({
        ...envelope,
        min_amount: minAmount,
        transactions_in_scope: page.universeTotal,
        transactions_with_a_document: page.universeTotal - page.rowsTotal,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to list unsupported transactions.'));
    }
  },
};

export const getDocumentTool: McpTool = {
  name: 'get_document',
  description:
    'One bank-transaction attachment by id, with its file name, size, mime type and the transaction it supports. ' +
    'Set include_content to also get the file as base64 — omit it unless you will actually read the bytes, since a scan can be several hundred kilobytes of response. ' +
    'DOES NOT COVER the entity document store (documents filed against an invoice or credit note): those are held in external file storage rather than inline, so list_documents returns their metadata and they must be fetched through the application.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: 'The attachment id from list_documents (store "bank_attachment").' },
      include_content: { type: 'boolean', description: 'Return the file bytes as base64. Default false.' },
    },
    required: ['document_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['document_id'] });
    if (bad) return bad;
    const documentId = strArg(args, 'document_id');
    if (!documentId) return toolError('document_id is required');
    try {
      const doc = await getBankTxAttachment(ctx.companyId, documentId, args.include_content === true);
      if (!doc) return toolError(NOT_FOUND);
      return ok({
        id: doc.id,
        store: 'bank_attachment',
        bank_transaction_id: doc.bankTransactionId,
        file_name: doc.fileName,
        file_size: doc.fileSize,
        mime_type: doc.mimeType,
        uploaded_at: doc.createdAt,
        ...(doc.content === undefined ? {} : { content: doc.content }),
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to read the document.'));
    }
  },
};
