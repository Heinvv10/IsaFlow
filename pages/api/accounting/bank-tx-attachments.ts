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
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/ocrService';
import { isVlmAvailable } from '@/modules/accounting/services/vlmService';

// ── Local Types ───────────────────────────────────────────────────────────────

// Neon's sql tagged template returns a union type. Casting through unknown[]
// is the project-standard pattern (see bankReconciliationService.ts Row = any).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlRow = Record<string, any>;

interface PostBody {
  bankTransactionId?: string;
  fileName?: string;
  fileData?: string; // base64 data URL: "data:<mime>;base64,<data>"
  fileSize?: number;
}

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

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId: string | null = req.user?.id ?? req.user?.userId ?? null;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { bankTransactionId } = req.query;

    if (!bankTransactionId || typeof bankTransactionId !== 'string') {
      return apiResponse.badRequest(res, 'bankTransactionId query param is required');
    }

    const rows = (await sql`
      SELECT
        id,
        bank_transaction_id,
        file_url,
        file_name,
        file_size,
        uploaded_by,
        created_at
      FROM bank_transaction_attachments
      WHERE bank_transaction_id = ${bankTransactionId}::UUID
      ORDER BY created_at DESC
    `) as SqlRow[];

    log.info('Listed bank tx attachments', { bankTransactionId, count: rows.length }, 'bank-tx-attachments');
    return apiResponse.success(res, rows);
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { bankTransactionId, fileName, fileData, fileSize } = req.body as PostBody;

    if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId is required');
    if (!fileName) return apiResponse.badRequest(res, 'fileName is required');
    if (!fileData || typeof fileData !== 'string') {
      return apiResponse.badRequest(res, 'fileData (base64 data URL) is required');
    }

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
    const byteSize = fileSize ?? estimateDataUrlBytes(fileData);
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

    const deleteRows = (await sql`
      DELETE FROM bank_transaction_attachments
      WHERE id = ${id}::UUID
      RETURNING id
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
