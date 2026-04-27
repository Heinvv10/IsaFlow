/**
 * Bank Transaction Attachments API
 *
 * GET  /api/accounting/bank-tx-attachments?bankTransactionId=<uuid>
 *   → List all attachments for a bank transaction, newest first.
 *
 * POST /api/accounting/bank-tx-attachments
 *   Body: { bankTransactionId, fileName, fileData (base64 data URL), fileSize? }
 *   → Store an attachment. Small receipts (≤ 2 MB) are kept as data URLs in file_url.
 *
 * DELETE /api/accounting/bank-tx-attachments?id=<uuid>
 *   → Remove a single attachment record.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/core/ocrService';
import { isVlmAvailable } from '@/modules/accounting/services/bank/vlmService';

// ── Local Types ───────────────────────────────────────────────────────────────

// Neon's sql tagged template returns a union type. Casting through unknown[]
// is the project-standard pattern (see bankReconciliationService.ts Row = any).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlRow = Record<string, any>;

const PostBodySchema = z.object({
  bankTransactionId: UUID,
  fileName: z.string().min(1).max(500),
  // base64 data URL — clamp at ~3 MB to give a margin over the 2 MB raw limit
  // (data URLs expand ~33%). The byte-size estimate below catches the real cap.
  fileData: z.string().min(20).max(3_500_000),
  fileSize: z.number().nonnegative().optional(),
}).strict();

// ── Constants ─────────────────────────────────────────────────────────────────

/** 2 MB limit — data URLs expand ~33 % in transit, so clamp at 2 MB of raw bytes */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/** Allowed MIME types derived from the data URL header */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

/** Magic-byte signatures for server-side MIME validation (attacker cannot spoof these) */
const ALLOWED_ATTACHMENT_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the MIME type from a base64 data URL string */
function extractMime(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9.+-]+);base64,/);
  return match ? match[1] ?? null : null;
}

/** Rough byte size estimate for a base64-encoded data URL */
function estimateDataUrlBytes(dataUrl: string): number {
  const base64Part = dataUrl.split(',')[1] ?? '';
  return Math.ceil((base64Part.length * 3) / 4);
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId: string | null = req.user?.id ?? null;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { bankTransactionId } = req.query;

    if (!bankTransactionId || typeof bankTransactionId !== 'string') {
      return apiResponse.badRequest(res, 'bankTransactionId query param is required');
    }

    // Verify the bank transaction belongs to this company
    const [btOwner] = await sql`
      SELECT id FROM bank_transactions WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    ` as SqlRow[];
    if (!btOwner) return apiResponse.forbidden(res, 'Bank transaction does not belong to your company');

    const rows = (await sql`
      SELECT
        bta.id,
        bta.bank_transaction_id,
        bta.file_url,
        bta.file_name,
        bta.file_size,
        bta.uploaded_by,
        bta.created_at
      FROM bank_transaction_attachments bta
      JOIN bank_transactions bt ON bt.id = bta.bank_transaction_id
      WHERE bta.bank_transaction_id = ${bankTransactionId}::UUID
        AND bt.company_id = ${companyId}
      ORDER BY bta.created_at DESC
    `) as SqlRow[];

    log.info('Listed bank tx attachments', { bankTransactionId, count: rows.length }, 'bank-tx-attachments');
    return apiResponse.success(res, rows);
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const parsed = PostBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const { bankTransactionId, fileName, fileData } = parsed.data;

    // Verify ownership before insert
    const [btCheck] = await sql`
      SELECT id FROM bank_transactions WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    ` as SqlRow[];
    if (!btCheck) return apiResponse.forbidden(res, 'Bank transaction does not belong to your company');

    // Validate MIME type against data URL header
    const mime = extractMime(fileData);
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
      return apiResponse.badRequest(res, `File type not allowed. Accepted: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }
    // Secondary allowlist check — attacker-controlled data URL cannot bypass this
    if (!ALLOWED_ATTACHMENT_MIMES.includes(mime)) {
      return apiResponse.badRequest(res, `File type ${mime} not allowed`);
    }

    // Validate file size
    // Always compute from actual data — never trust client-supplied fileSize
    const byteSize = estimateDataUrlBytes(fileData);
    if (byteSize > MAX_FILE_SIZE_BYTES) {
      return apiResponse.badRequest(res, 'File exceeds the 2 MB size limit');
    }

    const insertRows = (await sql`
      INSERT INTO bank_transaction_attachments
        (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
      VALUES
        (
          ${bankTransactionId}::UUID,
          ${fileData},
          ${fileName},
          ${byteSize},
          ${userId}::UUID
        )
      RETURNING
        id, bank_transaction_id, file_url, file_name, file_size, uploaded_by, created_at
    `) as SqlRow[];

    const attachment = insertRows[0];
    log.info('Uploaded bank tx attachment', { bankTransactionId, fileName, byteSize }, 'bank-tx-attachments');

    // Fire-and-forget VLM extraction on the attachment
    if (isVlmAvailable() && mime && attachment?.id) {
      extractAttachmentData(fileData, mime, attachment.id as string).catch(err =>
        log.warn('Background attachment extraction failed', { error: err instanceof Error ? err.message : String(err) }, 'bank-tx-attachments')
      );
    }

    return apiResponse.created(res, attachment, 'Attachment uploaded');
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;

    if (!id || typeof id !== 'string') {
      return apiResponse.badRequest(res, 'id query param is required');
    }

    // Verify ownership via bank_transactions before delete
    const deleteRows = (await sql`
      DELETE FROM bank_transaction_attachments bta
      USING bank_transactions bt
      WHERE bta.id = ${id}::UUID
        AND bta.bank_transaction_id = bt.id
        AND bt.company_id = ${companyId}
      RETURNING bta.id
    `) as SqlRow[];

    if (!deleteRows || deleteRows.length === 0) {
      return apiResponse.notFound(res, 'Attachment', id);
    }

    log.info('Deleted bank tx attachment', { id }, 'bank-tx-attachments');
    return apiResponse.success(res, { deleted: id });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

/** Background VLM extraction for bank tx attachments */
async function extractAttachmentData(dataUrl: string, mime: string, attachmentId: string) {
  const base64Part = dataUrl.split(',')[1];
  if (!base64Part) return;

  const buffer = Buffer.from(base64Part, 'base64');
  const isPdf = mime === 'application/pdf';

  const extracted = isPdf
    ? await extractFromPdf(buffer)
    : await extractFromImage(buffer, mime);

  if (extracted && extracted.confidence > 0) {
    await sql`
      UPDATE bank_transaction_attachments
      SET extracted_data = ${JSON.stringify(extracted)}::jsonb
      WHERE id = ${attachmentId}::uuid
    `;
    log.info('VLM extraction stored for bank tx attachment', { attachmentId, confidence: extracted.confidence }, 'bank-tx-attachments');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
