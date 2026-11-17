/**
 * MCP write tool: create_upload_urls — step 1 of attaching files WITHOUT sending their bytes through the tool call.
 *
 * Per file the agent declares the target (a bank line, or a bill / invoice / credit note / payment), name, mime type,
 * size and sha256. Each file is checked up front (target is the company's, mime allowed for that store, size within
 * the cap, not already on the target) and gets a one-time URL. The agent PUTs the bytes there outside MCP
 * (`curl -sS -T file "<url>"`: the URL is the only credential) and then calls finalize_uploads with the upload_ids.
 *
 * Per-file refusals are reported per file and never fail the batch. A file already on its target (same bytes sent
 * through this flow, same bytes on the bank line, or the same name and size) comes back duplicate: true, no URL.
 */
import type { McpTool, McpToolContext } from '../types';
import { appOrigin } from '../clientMetadata';
import { insertUploadIntent, purgeExpiredIntents, SHA256_RE, UPLOAD_TTL_MINUTES, type UploadTargetKind }
  from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { isValidUUID } from '@/lib/validation';
import { ok, toolError } from './toolHelpers';
import { resolveTxSelectors, type TxSelector } from './txSelectorResolve';
import { bankLineScopeError } from './writeAttachBankLineDocument';
import {
  ENTITY_TARGET_KINDS, MAX_UPLOAD_FILE_NAME, MAX_UPLOAD_ITEMS, defaultDocumentType, findExistingDocument,
  isBankKind, isValidDocumentType, maxBytesFor, mimeAllowedFor, mimeListFor, targetBelongsToCompany,
} from './uploadTargets';

type Parsed =
  | { error: string }
  | { kind: UploadTargetKind; id?: string; selector?: TxSelector; fileName: string; mime: string; size: number;
      sha256: string; documentType: string | null };

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');

function parseItem(raw: unknown, ctx: McpToolContext): Parsed {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'each file must be an object' };
  const f = raw as Record<string, unknown>;
  const t = (f.target && typeof f.target === 'object' && !Array.isArray(f.target)) ? f.target as Record<string, unknown> : null;
  if (!t) return { error: 'target is required: {entity_type, entity_id}, {bank_transaction_id} or {bank_reference}' };

  let kind: UploadTargetKind;
  let id: string | undefined;
  let selector: TxSelector | undefined;
  const entityType = str(t, 'entity_type');
  if (entityType) {
    if (entityType !== 'bank_transaction' && !(ENTITY_TARGET_KINDS as readonly string[]).includes(entityType)) {
      return { error: `invalid entity_type — expected bank_transaction or one of: ${ENTITY_TARGET_KINDS.join(', ')}` };
    }
    kind = entityType as UploadTargetKind;
    id = str(t, 'entity_id');
    if (!isValidUUID(id)) return { error: 'invalid entity_id' };
  } else if (str(t, 'bank_transaction_id')) {
    kind = 'bank_transaction';
    id = str(t, 'bank_transaction_id');
    if (!isValidUUID(id)) return { error: 'invalid bank_transaction_id' };
  } else if (str(t, 'bank_reference')) {
    kind = 'bank_transaction';
    const acct = str(t, 'bank_account_id');
    if (acct && !isValidUUID(acct)) return { error: 'invalid bank_account_id' };
    selector = { ref: str(t, 'bank_reference'), ...(acct ? { bankAccountId: acct } : {}) };
  } else {
    return { error: 'target needs entity_type + entity_id, bank_transaction_id, or bank_reference' };
  }
  if (isBankKind(kind)) {
    const refusal = bankLineScopeError(ctx);
    if (refusal) return { error: refusal.content[0]!.text };
  }

  const fileName = str(f, 'file_name');
  if (!fileName) return { error: 'file_name is required' };
  if (fileName.length > MAX_UPLOAD_FILE_NAME) return { error: `file_name exceeds ${MAX_UPLOAD_FILE_NAME} characters` };
  const mime = str(f, 'mime_type');
  if (!mimeAllowedFor(kind, mime)) return { error: `invalid mime_type — this target takes ${mimeListFor(kind)}` };
  const size = f.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { error: 'size must be the file size in bytes' };
  if (size > maxBytesFor(kind)) return { error: `File exceeds the ${maxBytesFor(kind) / (1024 * 1024)} MB limit for this target (got ${size} bytes)` };
  const sha256 = str(f, 'sha256').toLowerCase();
  if (!SHA256_RE.test(sha256)) return { error: 'sha256 must be the 64-character hex sha256 of the file' };
  const declaredType = str(f, 'document_type');
  if (declaredType && (isBankKind(kind) || !isValidDocumentType(declaredType))) {
    return { error: isBankKind(kind) ? 'a bank transaction keeps no document_type' : 'invalid document_type' };
  }
  return { kind, id, selector, fileName, mime, size, sha256, documentType: declaredType || defaultDocumentType(kind) };
}

export const createUploadUrlsTool: McpTool = {
  name: 'create_upload_urls',
  description:
    'Step 1 of 2 for attaching many or large files WITHOUT putting their bytes in a tool call (use this instead of base64 in attach_document / attach_entity_document for batches). ' +
    `Declare up to ${MAX_UPLOAD_ITEMS} files: each names its target ({entity_type, entity_id} for a supplier_invoice, customer_invoice, credit_note, supplier_payment, customer_payment or bank_transaction; or {bank_transaction_id}; or {bank_reference, bank_account_id?}), file_name, mime_type, size in bytes and the sha256 hex of the bytes. ` +
    'Each file gets a one-time upload url, valid 30 minutes. Upload the bytes OUTSIDE MCP with a plain PUT, e.g. curl -sS -T "file.pdf" "<url>" — the url is the only credential, so do not share it. Then call finalize_uploads with the upload_ids. ' +
    'Checked up front: the target is this company\'s, the mime type is allowed (bank lines: PDF, JPEG, PNG up to 2 MB; documents: PDF, JPEG, PNG, DOCX, XLSX up to 10 MB), and the file is not already there — a file already on its target (same bytes, or same name and size) comes back duplicate: true with its document_id and no url, so a batch can be re-run safely. ' +
    'A bank-line target needs write:bank-tx as well. Refusals are per file. Posts nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array', minItems: 1, maxItems: MAX_UPLOAD_ITEMS,
        items: {
          type: 'object',
          properties: {
            target: {
              type: 'object',
              properties: {
                entity_type: { type: 'string', enum: [...ENTITY_TARGET_KINDS, 'bank_transaction'] },
                entity_id: { type: 'string' },
                bank_transaction_id: { type: 'string' },
                bank_reference: { type: 'string' },
                bank_account_id: { type: 'string', description: 'Narrows bank_reference to one account.' },
              },
              additionalProperties: false,
            },
            file_name: { type: 'string' },
            mime_type: { type: 'string' },
            size: { type: 'integer', minimum: 1 },
            sha256: { type: 'string', description: 'Hex sha256 of the exact bytes you will upload.' },
            document_type: { type: 'string', description: 'Entity targets only; defaults as attach_entity_document.' },
          },
          required: ['target', 'file_name', 'mime_type', 'size', 'sha256'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['files', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0) return toolError('files is required: a list of files to upload');
    if (files.length > MAX_UPLOAD_ITEMS) return toolError(`at most ${MAX_UPLOAD_ITEMS} files per call`);

    const parsed = files.map((f) => parseItem(f, ctx));
    const refs = parsed.flatMap((p) => ('selector' in p && p.selector ? [p.selector] : []));
    const resolved = refs.length > 0 ? await resolveTxSelectors(refs, ctx.companyId) : [];
    let r = 0;

    await purgeExpiredIntents(ctx.companyId);
    const base = appOrigin();
    const seen = new Map<string, number>();
    const owned = new Map<string, boolean>();
    const uploads: Record<string, unknown>[] = [];
    for (const [index, p] of parsed.entries()) {
      if ('error' in p) { uploads.push({ index, status: 'refused', error: p.error }); continue; }
      let targetId = p.id;
      if (p.selector) {
        const res = resolved[r++]!;
        if ('error' in res) { uploads.push({ index, status: 'refused', error: res.error }); continue; }
        targetId = res.id;
      }
      const key = `${p.kind}:${targetId}`;
      if (!owned.has(key)) owned.set(key, await targetBelongsToCompany(ctx.companyId, p.kind, targetId!));
      if (!owned.get(key)) { uploads.push({ index, status: 'refused', error: 'Not found' }); continue; }

      const head = { index, file_name: p.fileName, target: { entity_type: p.kind, entity_id: targetId } };
      const sameInCall = seen.get(`${key}:${p.sha256}`);
      if (sameInCall !== undefined) { uploads.push({ ...head, status: 'duplicate', duplicate: true, duplicate_of_index: sameInCall }); continue; }
      seen.set(`${key}:${p.sha256}`, index);

      const existing = await findExistingDocument(ctx.companyId, p.kind, targetId!, p.fileName, p.size, p.sha256);
      if (existing) { uploads.push({ ...head, status: 'duplicate', duplicate: true, document_id: existing }); continue; }

      const intent = await insertUploadIntent(ctx.companyId, { userId: ctx.userId, tokenJti: ctx.tokenJti }, {
        targetKind: p.kind, targetId: targetId!, documentType: p.documentType,
        fileName: p.fileName, mimeType: p.mime, size: p.size, sha256: p.sha256,
      });
      uploads.push({ ...head, status: 'url_issued', duplicate: false, upload_id: intent.id,
        url: `${base}/api/mcp/uploads/${intent.token}`, expires_at: intent.expiresAt });
    }
    const count = (s: string) => uploads.filter((u) => u.status === s).length;
    return ok({
      uploads,
      urls_issued: count('url_issued'),
      duplicates: count('duplicate'),
      refused: count('refused'),
      next_step: `PUT each file's bytes to its url within ${UPLOAD_TTL_MINUTES} minutes (curl -sS -T "<file>" "<url>"), then call finalize_uploads with the upload_ids.`,
    });
  },
};
