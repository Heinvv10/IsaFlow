/**
 * MCP read tools for the document stores: list_documents, get_document and
 * list_unsupported_transactions.
 *
 * attach_document and the documents upload endpoint both write and nothing
 * read them back, which is why "which transactions over R10,000 have no
 * supporting document" — a standard audit test — has been unanswerable.
 */
import type { McpTool } from '../types';
import { listTransactionsWithoutDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { getBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { buildEnvelope } from '../contracts';
import {
  NOT_FOUND, clampLimit, guardCastableArgs, ok, safeErrorText, strArg, toolError,
} from './toolHelpers';

export { listDocumentsTool } from './listDocuments';

const MAX_LIMIT = 200;

export const listUnsupportedTransactionsTool: McpTool = {
  name: 'list_unsupported_transactions',
  description:
    'Bank transactions with NO supporting document attached — the "which transactions over R10,000 have no receipt" audit test. ' +
    'min_amount is compared against the ABSOLUTE amount, so a R12,000 payment out is caught as readily as one in. Rows come back largest first. ' +
    'transactions_in_scope is every transaction in the range over the threshold; transactions_with_a_document is how many of those do have one, so the two figures size the exposure rather than merely listing it. ' +
    'LIMIT: "supporting document" here means a document on the BANK TRANSACTION itself: a file attached to it (attach_document) or a captured document linked to it. A transaction whose evidence was filed against the related invoice instead is still reported as unsupported — those two stores are not linked. Treat the result as a list to check, not a list of failures.',
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
  // include_content returns the file as base64 (up to 4 MB) by design.
  allowLargeResult: true,
  description:
    'One bank-transaction document by id (store "bank_attachment" or "captured_document" from list_documents), with its file name, size, mime type and the transaction it supports. ' +
    'A captured document\'s content is returned only up to 4 MB; past that content_omitted says "too_large". ' +
    'Set include_content to also get the file as base64 — omit it unless you will actually read the bytes, since a scan can be several hundred kilobytes of response. ' +
    'DOES NOT COVER the entity document store (documents filed against an invoice or credit note): those are held in external file storage rather than inline, so list_documents returns their metadata and they must be fetched through the application.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: 'The id from list_documents (store "bank_attachment" or "captured_document").' },
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
        store: doc.store ?? 'bank_attachment',
        bank_transaction_id: doc.bankTransactionId,
        file_name: doc.fileName,
        file_size: doc.fileSize,
        mime_type: doc.mimeType,
        uploaded_at: doc.createdAt,
        ...(doc.content === undefined ? {} : { content: doc.content }),
        ...(doc.contentOmitted === undefined ? {} : { content_omitted: doc.contentOmitted }),
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to read the document.'));
    }
  },
};
