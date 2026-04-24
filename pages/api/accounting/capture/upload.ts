/**
 * POST /api/accounting/capture/upload
 * Multipart upload (PWA channel) — creates captured_documents + capture_events.
 */

import type { NextApiResponse } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';

export const config = { api: { bodyParser: false } };

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

function parseForm(
  req: import('next').NextApiRequest,
): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        // Reject parts without a declared MIME — pentest H13.
        const mime = part.mimetype ?? '';
        return !!mime && mime in ALLOWED_MIME_TYPES;
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

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const userId = req.user?.id ?? null;

  let files: formidable.Files;
  try {
    ({ files } = await parseForm(req));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('maxFileSize')) {
      return apiResponse.badRequest(res, `File too large. Max ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }
    return apiResponse.badRequest(res, `Upload parse error: ${msg}`);
  }

  const fileField = files.file ?? files.files ?? (files as Record<string, formidable.File[] | undefined>)['files[]'];
  const fileList = Array.isArray(fileField) ? fileField : fileField ? [fileField] : [];

  if (fileList.length === 0) {
    return apiResponse.badRequest(res, 'No files uploaded');
  }

  const eventIds: string[] = [];

  for (const file of fileList) {
    const mimeType = file.mimetype ?? '';
    const fileTypeKey = ALLOWED_MIME_TYPES[mimeType];
    if (!fileTypeKey) {
      log.warn('upload: skipping unsupported mime', { mimeType, name: file.originalFilename }, 'capture-upload');
      continue;
    }

    const buffer = fileBuffers.get(file);
    if (!buffer || buffer.length === 0) {
      log.warn('upload: empty buffer for file', { name: file.originalFilename }, 'capture-upload');
      continue;
    }

    const fileName = file.originalFilename || `upload_${Date.now()}.${fileTypeKey}`;
    const hash = sha256(buffer);

    const docRows = await sql`
      INSERT INTO captured_documents (
        company_id, file_name, file_type, file_size,
        document_type, status, uploaded_by,
        raw_bytes_sha256, raw_bytes_size
      ) VALUES (
        ${companyId}, ${fileName}, ${fileTypeKey}, ${file.size},
        'invoice', 'pending', ${userId},
        ${hash}, ${buffer.length}
      )
      RETURNING id
    ` as Row[];

    const documentId = docRows[0]!.id as string;
    const stored = await storeCapturedBytes(companyId, documentId, buffer, mimeType);

    await sql`
      UPDATE captured_documents
      SET storage_bucket = ${stored.bucket},
          storage_path   = ${stored.path}
      WHERE id = ${documentId}::uuid
        AND company_id = ${companyId}
    `;

    const eventRows = await sql`
      INSERT INTO capture_events (
        company_id, channel, sender, subject, status,
        captured_document_id, received_at
      ) VALUES (
        ${companyId}, 'pwa', ${userId}, ${fileName},
        'received', ${documentId}::uuid, NOW()
      )
      RETURNING id
    ` as Row[];

    const eventId = eventRows[0]!.id as string;
    eventIds.push(eventId);

    log.info('upload: capture event created', { companyId, documentId, eventId, fileName }, 'capture-upload');

    // Fire-and-forget VLM routing
    routeEvent(eventId, companyId).catch((err: unknown) => {
      log.error('routeEvent background error', {
        eventId,
        error: err instanceof Error ? err.message : String(err),
      }, 'capture-upload');
    });
  }

  if (eventIds.length === 0) {
    return apiResponse.badRequest(res, 'No valid files processed');
  }

  return apiResponse.created(res, { eventIds });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
