/**
 * GET /api/accounting/captured-document-file?id=<captured document uuid>
 *
 * The stored bytes of one of this company's captured documents, so a bank line's attachments can show a linked
 * document that was too large to copy into bank_transaction_attachments (capture/capturedAttachmentLinks).
 *
 * The bytes are never served as a renderable type. Content-Type is always application/octet-stream, with nosniff and
 * a sandbox CSP, and the disposition is attachment: navigating here saves a file and runs nothing. The viewer fetches
 * the bytes, reads their type from their first bytes, and shows only an inert image or PDF from a blob: URL.
 *
 * Read by any member of the company, like the attachments list. Tenant scope: fetchRawBytes reads the row by id AND
 * company_id, and storage refuses an object outside the company's prefix.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { fetchRawBytes } from '@/lib/documentStorage';
import { CapturedDocumentMissingError } from '@/lib/supabaseStorage';
import { detectMimeFromMagic } from '@/lib/fileMagic';
import { log } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/tiff': 'tif',
};

/** "document" plus the extension the bytes prove, else .bin, so a file saved from here cannot run. */
export function capturedDownloadName(bytes: Buffer): string {
  return `document.${EXTENSION[detectMimeFromMagic(bytes) ?? ''] ?? 'bin'}`;
}

// Captured documents go up to 10 MB; Next's 4 MB API response warning does not apply to a file download.
export const config = { api: { responseLimit: '12mb' } };

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'id must be a captured document id');
  const { companyId } = req;

  let raw: Awaited<ReturnType<typeof fetchRawBytes>>;
  try {
    raw = await fetchRawBytes(id, companyId);
  } catch (err) {
    if (err instanceof CapturedDocumentMissingError) raw = null;
    else throw err;
  }
  if (!raw) return apiResponse.notFound(res, 'Captured document', id);

  log.info('Served captured document bytes', { companyId, documentId: id, size: raw.buffer.length }, 'captured-document-file');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  // The page's download attribute names a same-origin save; this name is only for a save without it.
  res.setHeader('Content-Disposition', `attachment; filename="${capturedDownloadName(raw.buffer)}"`);
  res.status(200).send(raw.buffer);
}

export default withAuth(withErrorHandler(handler));
