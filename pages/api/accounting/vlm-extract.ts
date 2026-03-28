/**
 * VLM Extract API — Extract-only endpoint (no persistence)
 * POST /api/accounting/vlm-extract
 *
 * Accepts a file (PDF or image) via multipart form, runs VLM extraction,
 * returns ExtractedDocument without saving to any table.
 * Used by ScanAndFillButton on invoice/payment creation pages.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { log } from '@/lib/logger';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/ocrService';

export const config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
};

const fileBuffers = new WeakMap<formidable.File, Buffer>();

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        const mime = part.mimetype || '';
        return mime in ALLOWED_MIME_TYPES || !mime;
      },
      fileWriteStreamHandler: (file) => {
        const chunks: Buffer[] = [];
        const writable = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
          },
          final(callback) {
            fileBuffers.set(file as unknown as formidable.File, Buffer.concat(chunks));
            callback();
          },
        });
        return writable;
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { files } = await parseForm(req);

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;

    if (!file) {
      return apiResponse.badRequest(res, 'No file uploaded.');
    }

    const mimeType = file.mimetype || '';
    if (!(mimeType in ALLOWED_MIME_TYPES)) {
      return apiResponse.badRequest(res, `Unsupported file type: ${mimeType}`);
    }

    const buffer = fileBuffers.get(file);
    if (!buffer || buffer.length === 0) {
      return apiResponse.badRequest(res, 'Failed to read uploaded file');
    }

    const isPdf = buffer.subarray(0, 4).toString('hex').toUpperCase().startsWith('25504446');

    log.info('VLM extract-only request', {
      fileName: file.originalFilename,
      fileSize: file.size,
      mimeType,
    }, 'vlm-extract');

    const extracted = isPdf
      ? await extractFromPdf(buffer)
      : await extractFromImage(buffer, mimeType);

    return apiResponse.success(res, { extracted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('VLM extract failed', { error: msg }, 'vlm-extract');
    return apiResponse.internalError(res, err, `Extraction failed: ${msg}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
