/**
 * MCP write tool: finalize_uploads — step 2 of create_upload_urls. For each upload_id whose bytes were PUT to its url:
 * verify them (exact declared size, the declared sha256, magic bytes matching the declared mime type, a complete file of
 * that type), re-check the target is the company's and that the bytes are not already there, then write the document
 * (bank line: bank_transaction_attachments; anything else: the entity store); 999q's trigger clears the staged bytes.
 *
 * Per-file status, never a whole-batch failure: finalized (with document_id; duplicate: true when the same bytes were
 * already on the target), not_uploaded (no PUT yet), expired, refused (bytes failed verification: ask for a new url),
 * deferred (this call's 200 MB byte budget is spent: finalize it again), error (an unexpected failure; nothing was
 * stored for it: finalize it again), not_found. Finalizing an id again returns its first result, so a retried call is
 * safe. Every finalize and every refusal is written to audit_log ('create', duplicate 'update', refusal 'reject').
 *
 * Each item runs in its own savepoint: a throw unwinds that item only and answers 'error'. The dedup read happens
 * under a transaction-scoped advisory lock on (company, target, sha256), so two concurrent finalizes of the same bytes
 * store them once. An entity file is placed in object storage before its row, as attach_entity_document does, so an
 * unwound item can leave an unreferenced object behind (no worse than that tool).
 */
import type { McpTool, McpToolContext } from '../types';
import { withSavepoint } from '@/lib/neon';
import { isValidUUID } from '@/lib/validation';
import { log } from '@/lib/logger';
import { addBankTxAttachment, type AttachmentMime } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { storeDocumentBytes } from '@/modules/accounting/services/core/documentStorageService';
import { logAuditOrThrow, type AuditAction } from '@/modules/accounting/services/core/auditTrailService';
import {
  FINALIZE_WINDOW_HOURS, lockIntentForFinalize, lockUploadTarget, markIntentFinalized, markIntentRefused, readStagedBytes,
  type UploadIntent,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { sweepExpiredUploadsQuietly } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { uploadBytesRefusal } from '../uploadBytesCheck';
import { ok, toolError } from './toolHelpers';
import { bankLineScopeError } from './writeAttachBankLineDocument';
import { BANK_UPLOAD_MAX_BYTES, MAX_UPLOAD_ITEMS, findExistingDocument, isBankKind, targetBelongsToCompany } from './uploadTargets';

/** Staged bytes read and written per call; the rest are answered 'deferred' without being read. */
export const FINALIZE_MAX_BYTES_PER_CALL = 200 * 1024 * 1024;

type FileResult = Record<string, unknown> & { upload_id: string; status: string };
type Outcome = { result: FileResult; bytesRead: number };

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

async function audit(
  ctx: McpToolContext, i: UploadIntent, action: AuditAction, metadata: Record<string, string>,
): Promise<void> {
  await logAuditOrThrow({
    companyId: ctx.companyId, userId: ctx.userId, action, entityType: i.targetKind, entityId: i.targetId,
    entityRef: i.fileName.slice(0, 100),
    changes: { fields: [], metadata: {
      source: 'mcp finalize_uploads', upload_id: i.id, sha256: i.sha256, size: String(i.declaredSize),
      token_jti: ctx.tokenJti ?? '', ...metadata,
    } },
  });
}

/** A refusal: recorded on the row when `mark` (the bytes were judged), audited either way. */
async function refuse(ctx: McpToolContext, i: UploadIntent, head: Record<string, unknown>, reason: string, mark: boolean): Promise<FileResult> {
  if (mark) await markIntentRefused(ctx.companyId, i.id, reason);
  await audit(ctx, i, 'reject', { outcome: 'refused', reason: reason.slice(0, 200) });
  return { upload_id: i.id, ...head, status: 'refused', error: reason };
}

async function finalizeOne(ctx: McpToolContext, uploadId: string, budgetLeft: number): Promise<Outcome> {
  const none = (result: FileResult): Outcome => ({ result, bytesRead: 0 });
  const i = await lockIntentForFinalize(ctx.companyId, uploadId);
  // Bound to the principal that asked for the url: the same user AND the same token. Another member's (or another
  // connection's) id reads as not_found, exactly like another company's.
  if (!i || i.createdBy !== ctx.userId || i.createdTokenJti !== (ctx.tokenJti ?? null)) {
    return none({ upload_id: uploadId, status: 'not_found' });
  }
  const head = { upload_id: uploadId, file_name: i.fileName, target: { entity_type: i.targetKind, entity_id: i.targetId } };
  // A bank line needs write:bank-tx on top of write:invoices, at finalize as at create. Refused before any read of the
  // bytes or write; the url stays as it was.
  if (isBankKind(i.targetKind)) {
    const scopeRefusal = bankLineScopeError(ctx);
    if (scopeRefusal) return none(await refuse(ctx, i, head, scopeRefusal.content[0]!.text, false));
  }
  if (i.status === 'finalized') {
    return none({ ...head, status: 'finalized', document_id: i.resultDocumentId, duplicate: i.resultDuplicate === true });
  }
  if (i.status === 'refused') return none({ ...head, status: 'refused', error: i.refusal });
  if (i.expired) return none({ ...head, status: 'expired', error: 'the upload expired: create a new url' });
  if (i.status === 'pending') return none({ ...head, status: 'not_uploaded', error: 'no bytes were PUT to the url yet' });
  if (i.declaredSize > budgetLeft) {
    return none({ ...head, status: 'deferred',
      error: `this call's ${FINALIZE_MAX_BYTES_PER_CALL / (1024 * 1024)} MB budget is spent: call finalize_uploads again with this upload_id (within ${FINALIZE_WINDOW_HOURS} hours of its upload)` });
  }

  const bytes = (await readStagedBytes(ctx.companyId, i.id)) ?? Buffer.alloc(0);
  const read = (result: FileResult): Outcome => ({ result, bytesRead: i.declaredSize });
  const bad = uploadBytesRefusal(bytes, i);
  if (bad) return read(await refuse(ctx, i, head, bad, true));
  if (!(await targetBelongsToCompany(ctx.companyId, i.targetKind, i.targetId))) {
    return read(await refuse(ctx, i, head, 'Not found', true));
  }

  // Before the dedup read: a concurrent finalize (or attach_document) of these bytes to this target waits here, then
  // finds what the first one stored.
  await lockUploadTarget(ctx.companyId, i.targetKind, i.targetId, i.sha256);
  const existing = await findExistingDocument(ctx.companyId, i.targetKind, i.targetId, i.declaredSize, i.sha256);
  if (existing) {
    await markIntentFinalized(ctx.companyId, i.id, existing, true);
    await audit(ctx, i, 'update', { outcome: 'duplicate', document_id: existing, duplicate: 'true' });
    return read({ ...head, status: 'finalized', document_id: existing, duplicate: true });
  }
  const written = await writeDocument(ctx, i, bytes);
  if (typeof written !== 'string') return read(await refuse(ctx, i, head, written.refused, true));
  await markIntentFinalized(ctx.companyId, i.id, written, false);
  await audit(ctx, i, 'create', { outcome: 'stored', document_id: written, duplicate: 'false' });
  return read({ ...head, status: 'finalized', document_id: written, duplicate: false });
}

/** One item in its own savepoint: a throw unwinds that item's writes only and answers 'error' for it. */
async function finalizeIsolated(ctx: McpToolContext, uploadId: string, budgetLeft: number): Promise<Outcome> {
  try {
    return await withSavepoint('mcp_finalize_upload', () => finalizeOne(ctx, uploadId, budgetLeft));
  } catch (err) {
    log.error('MCP finalize_uploads item failed', {
      companyId: ctx.companyId, uploadId, error: err instanceof Error ? err.message : String(err),
    }, 'mcp-uploads');
    return { result: { upload_id: uploadId, status: 'error',
      error: 'finalizing this file failed and nothing was stored for it: call finalize_uploads again with this upload_id' }, bytesRead: 0 };
  }
}

export const finalizeUploadsTool: McpTool = {
  name: 'finalize_uploads',
  description:
    'Step 2 of 2 after create_upload_urls: once each file\'s bytes have been PUT to its url, pass the upload_ids here. ' +
    'Each upload is verified (exact size, the declared sha256, file contents matching the declared mime type and complete), checked again for the same bytes already on its target, and then attached: a bank line\'s file to the line, any other to the bill / invoice / credit note / payment. ' +
    `Per-file status: finalized (with document_id; duplicate: true when the same bytes were already there, nothing stored twice), not_uploaded, expired (urls last 30 minutes; an uploaded file can be finalized for ${FINALIZE_WINDOW_HOURS} hours), refused (bytes failed verification — create a new url), deferred (at most ${FINALIZE_MAX_BYTES_PER_CALL / (1024 * 1024)} MB per call: call again with those ids), error (nothing stored for it: call again), not_found. ` +
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

    await sweepExpiredUploadsQuietly();
    const files: FileResult[] = [];
    let budget = FINALIZE_MAX_BYTES_PER_CALL;
    for (const id of unique) {
      const { result, bytesRead } = await finalizeIsolated(ctx, id, budget);
      budget -= bytesRead;
      files.push(result);
    }

    const count = (s: string) => files.filter((f) => f.status === s).length;
    const finalized = files.filter((f) => f.status === 'finalized');
    const duplicates = finalized.filter((f) => f.duplicate === true).length;
    log.info('MCP finalize_uploads', {
      companyId: ctx.companyId, files: files.length, finalized: finalized.length, duplicates,
      deferred: count('deferred'), errors: count('error'),
    }, 'mcp-uploads');
    return ok({
      files,
      finalized: finalized.length,
      duplicates,
      not_uploaded: count('not_uploaded'),
      expired: count('expired'),
      refused: count('refused'),
      deferred: count('deferred'),
      errors: count('error'),
      not_found: count('not_found'),
    });
  },
};
