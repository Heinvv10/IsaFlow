/**
 * MCP write tool: attach_document — put a receipt / invoice scan on a bank
 * transaction. Posts nothing, so no requiresPost.
 *
 * The bytes travel base64 in the args. The transport body cap is 3 MB, so the
 * file cap is the bank store's own 2 MB (base64 ~2.7 MB). Many or larger files
 * go through create_upload_urls / finalize_uploads, which carry no bytes.
 * A file already on the line (same bytes, or same stored name and size) is not
 * stored again: duplicate: true, as attach_entity_document does.
 * Every refusal here — and every refusal the service returns — happens BEFORE
 * its INSERT, so returning toolError is safe; a failure after the insert
 * would be a throw, which the registry savepoint unwinds.
 */
import type { McpTool } from '../types';
import {
  ATTACHMENT_MIME_TYPES,
  addBankTxAttachment,
  type AttachmentMime,
} from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { decodeUploadPayload } from '@/lib/fileMagic';
import { findBankLineDuplicate } from '@/modules/accounting/services/core/bankLineDocumentRouting';
import { findBankLineShaDuplicate } from '@/modules/accounting/services/bank/bankLineShaDuplicate';
import { sha256Hex } from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { pickTxSelector, resolveTxId } from './txSelectorResolve';

export const ATTACH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILE_NAME = 200;

export const attachDocumentTool: McpTool = {
  name: 'attach_document',
  description:
    'Attach a document (JPEG, PNG or PDF — a receipt, slip or invoice scan) to a bank transaction, named by transaction_id or by bank_reference (plus bank_account_id to narrow an ambiguous reference). ' +
    'content is the file as base64 (a data: URL is also accepted). Maximum 2 MB of file bytes per call. For many files, or to keep file bytes out of the tool call, use create_upload_urls then finalize_uploads instead. ' +
    'The declared mime_type is checked against the file\'s real bytes and refused on mismatch. ' +
    'If the line already holds the same file (same bytes, or the same file name and size), nothing is stored and that attachment comes back with duplicate: true, so a sync can be re-run safely. ' +
    'Posts nothing and changes no allocation.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string' },
      bank_reference: { type: 'string', description: 'Statement reference, as an alternative to transaction_id.' },
      bank_account_id: { type: 'string', description: 'Narrows bank_reference to one account.' },
      file_name: { type: 'string', description: 'e.g. "makro-2026-08-14.pdf"' },
      mime_type: { type: 'string', enum: [...ATTACHMENT_MIME_TYPES] },
      content: { type: 'string', description: 'Base64 file bytes, or a data:<mime>;base64,… URL.' },
      idempotency_key: { type: 'string' },
    },
    required: ['file_name', 'mime_type', 'content', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const fileName = strArg(args, 'file_name');
    if (!fileName) return toolError('file_name is required');
    if (fileName.length > MAX_FILE_NAME) return toolError(`file_name exceeds ${MAX_FILE_NAME} characters`);

    const mimeType = strArg(args, 'mime_type');
    // enum is advisory — the transport does not validate against inputSchema.
    if (!mimeType || !(ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType)) {
      return toolError(`invalid mime_type — expected one of: ${ATTACHMENT_MIME_TYPES.join(', ')}`);
    }

    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) return toolError('content is required');
    const bytes = decodeUploadPayload(content);
    if (!bytes) return toolError('content is not valid base64');

    const selector = pickTxSelector(args);
    if (typeof selector === 'string') return toolError(selector);
    // transaction_id / bank_account_id land as $n::UUID.
    const bad = guardCastableArgs(args, { uuid: ['transaction_id', 'bank_account_id'] });
    if (bad) return bad;
    const resolved = await resolveTxId(selector, ctx.companyId);
    if ('error' in resolved) return toolError(resolved.error);

    if (bytes.length > ATTACH_MAX_BYTES) {
      return toolError(`File exceeds the ${ATTACH_MAX_BYTES / (1024 * 1024)} MB limit (got ${bytes.length} bytes)`);
    }
    // Duplicate checks read only rows of a line that is the company's (both finders join its company_id); a foreign
    // or unknown line finds nothing and the service below refuses it as Not found.
    const sameBytes = await findBankLineShaDuplicate(ctx.companyId, resolved.id, sha256Hex(bytes));
    const sameName = sameBytes ? null : await findBankLineDuplicate(ctx.companyId, resolved.id, fileName, bytes.length);
    if (sameBytes || sameName) {
      return ok({
        attachment_id: sameBytes ?? sameName!.id,
        transaction_id: resolved.id,
        file_name: sameName?.documentName ?? fileName,
        duplicate: true,
      });
    }

    const result = await addBankTxAttachment(ctx.companyId, {
      bankTransactionId: resolved.id,
      fileName,
      mimeType: mimeType as AttachmentMime,
      bytes,
      maxBytes: ATTACH_MAX_BYTES,
      uploadedBy: ctx.userId,
    });
    if (!result.ok) {
      switch (result.reason) {
        // Cross-tenant and genuine miss read identically.
        case 'bank_tx_not_found': return toolError(NOT_FOUND);
        case 'type_mismatch': return toolError(`File contents do not match mime_type ${mimeType}`);
        case 'too_large': return toolError(`File exceeds the ${ATTACH_MAX_BYTES / (1024 * 1024)} MB limit (got ${bytes.length} bytes)`);
        case 'empty': return toolError('content decoded to zero bytes');
      }
    }
    const a = result.attachment;
    return ok({
      attachment_id: a.id,
      transaction_id: a.bankTransactionId,
      file_name: a.fileName,
      file_size: a.fileSize,
      mime_type: a.mimeType,
      created_at: a.createdAt,
      duplicate: false,
    });
  },
};
