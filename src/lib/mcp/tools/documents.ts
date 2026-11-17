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
    'Bank transactions with NO supporting evidence — the "which transactions over R10,000 have no receipt" audit test. ' +
    'min_amount is compared against the ABSOLUTE amount, so a R12,000 payment out is caught as readily as one in. Rows come back largest first. ' +
    'Each row carries evidence: "own" (a document on the bank line itself: an attach_document file or a linked captured document), "settled_document" (no own document, but the line pays or receives a bill / customer invoice that carries its own document, through the supplier / customer payment or supplier payment batch its posted journal belongs to) or "none". A credit note\'s document alone is not evidence. A gateway payout line does not reach the receipts it pays out, so it reads "none". ' +
    'By default a row is unsupported when it has NO evidence of either kind; strict: true keeps the old test (no OWN document, whatever it settles). ' +
    'Totals: transactions_in_scope, with_own_document, with_settled_document, no_evidence (they partition the scope), plus transactions_with_a_document (in scope minus unsupported, under the chosen test). ' +
    'exclude_transfers: true drops lines that move money between the company\'s own accounts (an interbank transfer, or a line coded to a bank / cash / card account); give transfer_account_codes for clearing accounts the chart does not mark as money accounts (e.g. ["1150","1560731"]). ' +
    'Settled-document evidence is an audit read only: it does not count as a VAT input document for any journal other than the bill itself.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Transaction date from, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Transaction date to, YYYY-MM-DD.' },
      min_amount: { type: 'number', minimum: 0, description: 'Materiality threshold on ABS(amount). Default 0 — everything.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      strict: { type: 'boolean', description: 'true: unsupported = no document on the line itself (ignores settled bills / invoices). Default false.' },
      exclude_transfers: { type: 'boolean', description: 'Drop transfers between the company\'s own accounts. Default false.' },
      transfer_account_codes: {
        type: 'array', items: { type: 'string' }, maxItems: 20,
        description: 'With exclude_transfers: GL account codes that are transfer / clearing accounts, e.g. ["1150","1560731"].',
      },
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
    for (const flag of ['strict', 'exclude_transfers'] as const) {
      if (args[flag] !== undefined && typeof args[flag] !== 'boolean') return toolError(`${flag} must be true or false`);
    }
    const codes = args.transfer_account_codes;
    if (codes !== undefined && (!Array.isArray(codes) || codes.length > 20
      || codes.some((c) => typeof c !== 'string' || c.length === 0 || c.length > 20))) {
      return toolError('transfer_account_codes must be up to 20 account codes (strings of 1-20 characters)');
    }
    try {
      const page = await listTransactionsWithoutDocuments(ctx.companyId, {
        from, to, minAmount, limit: clampLimit(args, 50, MAX_LIMIT),
        strict: args.strict === true,
        excludeTransfers: args.exclude_transfers === true,
        transferAccountCodes: (codes as string[] | undefined) ?? [],
      });
      const envelope = buildEnvelope({
        rows: page.rows.map((r) => ({
          transaction_id: r.id,
          transaction_date: r.transactionDate,
          amount: r.amount,
          description: r.description,
          reference: r.reference,
          status: r.status,
          evidence: r.evidence,
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
        strict: args.strict === true,
        exclude_transfers: args.exclude_transfers === true,
        transactions_in_scope: page.universeTotal,
        transactions_with_a_document: page.universeTotal - page.rowsTotal,
        with_own_document: page.withOwnDocument,
        with_settled_document: page.withSettledDocument,
        no_evidence: page.noEvidence,
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
