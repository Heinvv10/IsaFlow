/**
 * Multi-Document Match API
 * POST /api/accounting/multi-doc-match — Upload up to 3 files (PO, GRN, Invoice), cross-match them
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { log } from '@/lib/logger';
import { performMultiDocMatch } from '@/modules/accounting/services/multiDocMatchService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

export const config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_FILES = 3;

const ALLOWED_MIME_TYPES: Record<string, boolean> = {
  'application/pdf': true,
  'image/jpeg': true,
  'image/jpg': true,
  'image/png': true,
};

const fileBuffers = new WeakMap<formidable.File, Buffer>();

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      maxFiles: MAX_FILES,
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

  const { fields } = await parseForm(req);

  // Documents are passed as pre-extracted JSON in the `documents` field
  // (VLM extraction happens upstream or in document-capture endpoint)
  const documentsRaw = Array.isArray(fields.documents) ? fields.documents[0] : fields.documents;

  if (!documentsRaw) {
    return apiResponse.badRequest(res, 'documents field is required — provide an array of ExtractedDocument JSON');
  }

  let documents: ExtractedDocument[];
  try {
    const parsed = JSON.parse(documentsRaw);
    if (!Array.isArray(parsed)) {
      return apiResponse.badRequest(res, 'documents must be a JSON array');
    }
    documents = parsed as ExtractedDocument[];
  } catch {
    return apiResponse.badRequest(res, 'Invalid documents JSON');
  }

  if (documents.length < 2) {
    return apiResponse.badRequest(res, 'At least 2 documents are required for multi-document matching');
  }

  if (documents.length > MAX_FILES) {
    return apiResponse.badRequest(res, `Maximum ${MAX_FILES} documents allowed`);
  }

  // Validate each document has minimum required fields
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]!;
    if (!doc.documentType) {
      return apiResponse.badRequest(res, `Document at index ${i} is missing documentType`);
    }
  }

  log.info('Starting multi-document match', {
    documentCount: documents.length,
    types: documents.map(d => d.documentType),
  }, 'multi-doc-match');

  const result = performMultiDocMatch({ documents });

  log.info('Multi-document match complete', {
    matchStatus: result.matchStatus,
    overallConfidence: result.overallConfidence,
    discrepancies: result.discrepancies.length,
    missingDocuments: result.missingDocuments,
  }, 'multi-doc-match');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
