/**
 * The bank-line arm of attach_entity_document (entity_type "bank_transaction"): routes the file to the bank-tx
 * attachment store so a caller never has to know that a bank line's receipts live apart from a bill's documents.
 * attach_document (selector by reference) stays for callers that hold a statement reference rather than an id.
 *
 * Every refusal here precedes addBankTxAttachment's INSERT, so toolError is safe throughout. The line must be the
 * token's company's (reads as the shared "Not found"); the token needs write:bank-tx on top of the tool's write:invoices.
 */
import type { McpToolContext, McpToolResult } from '../types';
import {
  ATTACHMENT_MIME_TYPES, addBankTxAttachment, type AttachmentMime,
} from '@/modules/accounting/services/bank/bankTxAttachmentService';
import {
  BANK_ENTITY_TYPE, bankTxBelongsToCompany, findBankLineDuplicate, fromStoredAttachment,
} from '@/modules/accounting/services/core/bankLineDocumentRouting';
import type { LinkedDocument } from '@/types/procurement/document.types';
import { insufficientScopeMessage } from '../scopeRemediation';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

const BANK_WRITE_SCOPE = 'write:bank-tx';

/** Refusal text when the token cannot write bank-line documents, else null. Runs before anything is read. */
export function bankLineScopeError(ctx: McpToolContext): McpToolResult | null {
  return ctx.scopes.includes(BANK_WRITE_SCOPE) ? null : toolError(insufficientScopeMessage(BANK_WRITE_SCOPE));
}

/** True when a bank line can hold this mime type (PDF, JPEG, PNG — narrower than the entity store). */
export const bankLineAcceptsMime = (mime: string): boolean => (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);

export const BANK_LINE_MIME_REFUSAL = `a bank transaction takes ${ATTACHMENT_MIME_TYPES.join(', ')} only`;

function shape(d: LinkedDocument, duplicate: boolean): McpToolResult {
  return ok({
    document_id: d.id,
    entity_type: BANK_ENTITY_TYPE,
    entity_id: d.entityId,
    document_type: null,
    file_name: d.documentName,
    file_size: d.fileSize ?? null,
    mime_type: d.mimeType ?? null,
    uploaded_at: d.uploadedAt,
    duplicate,
  });
}

export async function attachToBankLine(
  ctx: McpToolContext,
  input: { bankTxId: string; fileName: string; mimeType: string; bytes: Buffer; maxBytes: number },
): Promise<McpToolResult> {
  if (!(await bankTxBelongsToCompany(ctx.companyId, input.bankTxId))) return toolError(NOT_FOUND);

  const existing = await findBankLineDuplicate(ctx.companyId, input.bankTxId, input.fileName, input.bytes.length);
  if (existing) return shape(existing, true);

  const result = await addBankTxAttachment(ctx.companyId, {
    bankTransactionId: input.bankTxId,
    fileName: input.fileName,
    mimeType: input.mimeType as AttachmentMime,
    bytes: input.bytes,
    maxBytes: input.maxBytes,
    uploadedBy: ctx.userId,
  });
  if (!result.ok) {
    switch (result.reason) {
      case 'bank_tx_not_found': return toolError(NOT_FOUND);
      case 'type_mismatch': return toolError(`File contents do not match mime_type ${input.mimeType}`);
      case 'too_large': return toolError(`File exceeds the ${Math.floor(input.maxBytes / (1024 * 1024))} MB limit (got ${input.bytes.length} bytes)`);
      case 'empty': return toolError('content decoded to zero bytes');
    }
  }
  return shape(fromStoredAttachment(result.attachment), false);
}
