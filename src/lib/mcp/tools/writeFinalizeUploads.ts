/**
 * MCP write tool: finalize_uploads — step 2 of create_upload_urls. For each upload_id whose bytes were PUT to its url:
 * verify them (exact declared size, the declared sha256, magic bytes matching the declared mime type), re-check the
 * target is the company's and that the file is not already there, then write the document (bank line:
 * bank_transaction_attachments; anything else: the entity store) and clear the staged bytes. Every finalize is written
 * to audit_log.
 *
 * Per-file status, never a whole-batch failure: finalized (with document_id; duplicate: true when the file was already
 * on the target), not_uploaded (no PUT yet), expired, refused (bytes failed verification: ask for a new url),
 * not_found. Finalizing an id again returns its first result, so a retried call is safe.
 *
 * Every refusal is decided before its write; a throw after a write is unwound by the registry savepoint. An entity file
 * is placed in object storage before its row, as attach_entity_document does, so an unwound row can leave an
 * unreferenced object behind (no worse than that tool).
 */
import type { McpTool, McpToolContext } from '../types';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import { isValidUUID } from '@/lib/validation';
import { log } from '@/lib/logger';
import { addBankTxAttachment, type AttachmentMime } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { storeDocumentBytes } from '@/modules/accounting/services/core/documentStorageService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import {
  lockIntentForFinalize, markIntentFinalized, markIntentRefused, purgeExpiredIntents, sha256Hex, type UploadIntent,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { ok, toolError } from './toolHelpers';
import { BANK_UPLOAD_MAX_BYTES, MAX_UPLOAD_ITEMS, findExistingDocument, isBankKind, targetBelongsToCompany } from './uploadTargets';

type FileResult = Record<string, unknown> & { upload_id: string; status: string };

function verifyBytes(i: UploadIntent): string | null {
  const b = i.stagedBytes;
  if (!b || b.length === 0) return 'no bytes staged';
  if (b.length !== i.declaredSize) return `size ${b.length} does not match the declared ${i.declaredSize}`;
  if (sha256Hex(b) !== i.sha256) return 'sha256 of the uploaded bytes does not match the declared sha256';
  if (!magicBytesMatchMime(b, i.mimeType)) return `file contents do not match mime_type ${i.mimeType}`;
  return null;
}

async function writeDocument(ctx: McpToolContext, i: UploadIntent, bytes: Buffer): Promise<string | { refused: string }> {
  if (isBankKind(i.targetKind)) {
    const r = await addBankTxAttachment(ctx.companyId, {
      bankTransactionId: i.targetId, fileName: i.fileName, mimeType: i.mimeType as AttachmentMime,
      bytes, maxBytes: BANK_UPLOAD_MAX_BYTES, uploadedBy: ctx.userId,
    });
    return r.ok ? r.attachment.id : { refused: r.reason === 'bank_tx_not_found' ? 'Not found' : `attachment refused: ${r.reason}` };
  }
  const doc = await storeDocumentBytes({
    companyId: ctx.companyId, entityType: i.targetKind, entityId: i.targetId,
    documentType: i.documentType ?? 'other', notes: undefined, buffer: bytes, mimeType: i.mimeType, size: bytes.length,
    originalFilename: i.fileName, uploadedBy: ctx.userId, uploadedByName: 'mcp', extract: false,
  });
  return doc.id;
}

async function finalizeOne(ctx: McpToolContext, uploadId: string): Promise<FileResult> {
  const i = await lockIntentForFinalize(ctx.companyId, uploadId);
  if (!i) return { upload_id: uploadId, status: 'not_found' };
  const head = { upload_id: uploadId, file_name: i.fileName, target: { entity_type: i.targetKind, entity_id: i.targetId } };
  if (i.status === 'finalized') {
    return { ...head, status: 'finalized', document_id: i.resultDocumentId, duplicate: i.resultDuplicate === true };
  }
  if (i.status === 'refused') return { ...head, status: 'refused', error: i.refusal };
  if (i.expired) return { ...head, status: 'expired', error: 'the upload url expired: create a new one' };
  if (i.status === 'pending') return { ...head, status: 'not_uploaded', error: 'no bytes were PUT to the url yet' };

  const bad = verifyBytes(i);
  if (bad) {
    await markIntentRefused(ctx.companyId, i.id, bad);
    return { ...head, status: 'refused', error: bad };
  }
  if (!(await targetBelongsToCompany(ctx.companyId, i.targetKind, i.targetId))) {
    await markIntentRefused(ctx.companyId, i.id, 'target not found');
    return { ...head, status: 'refused', error: 'Not found' };
  }

  let documentId = await findExistingDocument(ctx.companyId, i.targetKind, i.targetId, i.fileName, i.declaredSize, i.sha256);
  const duplicate = documentId !== null;
  if (!documentId) {
    const written = await writeDocument(ctx, i, i.stagedBytes!);
    if (typeof written !== 'string') {
      await markIntentRefused(ctx.companyId, i.id, written.refused);
      return { ...head, status: 'refused', error: written.refused };
    }
    documentId = written;
  }
  await markIntentFinalized(ctx.companyId, i.id, documentId, duplicate);
  await logAuditOrThrow({
    companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: i.targetKind, entityId: i.targetId,
    entityRef: i.fileName.slice(0, 100),
    changes: { fields: [], metadata: {
      source: 'mcp finalize_uploads', upload_id: i.id, document_id: documentId, sha256: i.sha256,
      size: String(i.declaredSize), duplicate: String(duplicate), token_jti: ctx.tokenJti ?? '',
    } },
  });
  return { ...head, status: 'finalized', document_id: documentId, duplicate };
}

export const finalizeUploadsTool: McpTool = {
  name: 'finalize_uploads',
  description:
    'Step 2 of 2 after create_upload_urls: once each file\'s bytes have been PUT to its url, pass the upload_ids here. ' +
    'Each upload is verified (exact size, the declared sha256, file contents matching the declared mime type), checked again for a duplicate on its target, and then attached: a bank line\'s file to the line, any other to the bill / invoice / credit note / payment. ' +
    'Per-file status: finalized (with document_id; duplicate: true when the file was already there, nothing stored twice), not_uploaded, expired (urls last 30 minutes), refused (bytes failed verification — create a new url), not_found. ' +
    `Up to ${MAX_UPLOAD_ITEMS} upload_ids per call. Finalizing an id again returns its first result. Posts nothing.`,
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      upload_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_UPLOAD_ITEMS },
      idempotency_key: { type: 'string' },
    },
    required: ['upload_ids', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ids = args.upload_ids;
    if (!Array.isArray(ids) || ids.length === 0) return toolError('upload_ids is required: the ids create_upload_urls returned');
    if (ids.length > MAX_UPLOAD_ITEMS) return toolError(`at most ${MAX_UPLOAD_ITEMS} upload_ids per call`);
    if (!ids.every((id) => typeof id === 'string' && isValidUUID(id))) return toolError('invalid upload_ids: each must be an upload_id');
    const unique = [...new Set(ids as string[])];

    const files: FileResult[] = [];
    for (const id of unique) files.push(await finalizeOne(ctx, id));
    await purgeExpiredIntents(ctx.companyId);

    const count = (s: string) => files.filter((f) => f.status === s).length;
    const finalized = files.filter((f) => f.status === 'finalized');
    log.info('MCP finalize_uploads', {
      companyId: ctx.companyId, files: files.length, finalized: finalized.length,
      duplicates: finalized.filter((f) => f.duplicate === true).length,
    }, 'mcp-uploads');
    return ok({
      files,
      finalized: finalized.length,
      duplicates: finalized.filter((f) => f.duplicate === true).length,
      not_uploaded: count('not_uploaded'),
      expired: count('expired'),
      refused: count('refused'),
      not_found: count('not_found'),
    });
  },
};
