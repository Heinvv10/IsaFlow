/**
 * VLM Extract API — Extract-only endpoint (no persistence)
 * POST /api/accounting/vlm-extract            — start a read, answers 202 { jobId }
 * GET  /api/accounting/vlm-extract?job=<uuid> — { state: 'reading' | 'done' | 'failed', extracted?, error? }
 *
 * Accepts a file (PDF or image) via multipart form and runs VLM extraction without saving to any table.
 * A long digital PDF outlasts Cloudflare's 100 s, so the read runs after the request (runAfterCommit) and its
 * result waits in a process-local store (vlmExtractJobs) for the client's poll, visible only to the same company
 * AND user. Used by ScanAndFillButton on invoice/payment creation pages.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { runAfterCommit } from '@/lib/afterCommit';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkAiRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import {
  ALLOWED_MIME_TYPES, parseUploadForm, readUploadedDocument, uploadedBuffer,
} from '@/modules/accounting/services/capture/captureUploadForm';
import {
  getVlmExtractJob, registerVlmExtractJob, runVlmExtractJob,
} from '@/modules/accounting/services/bank/vlmExtractJobs';

export const config = {
  api: { bodyParser: false },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

/** GET ?job= — the outcome of a scan, for the company and user that started it. */
function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;
  const job = req.query.job;
  if (typeof job !== 'string' || !UUID_RE.test(job)) return apiResponse.badRequest(res, 'job must be a UUID');
  const view = getVlmExtractJob(job, companyId, user?.id ?? '');
  if (!view) return apiResponse.notFound(res, 'Scan', job);
  return apiResponse.success(res, view);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  try {
    const { files } = await parseUploadForm(req);

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;

    if (!file) {
      return apiResponse.badRequest(res, 'No file uploaded.');
    }

    const mimeType = file.mimetype || '';
    if (!(mimeType in ALLOWED_MIME_TYPES)) {
      return apiResponse.badRequest(res, `Unsupported file type: ${mimeType}`);
    }

    const buffer = uploadedBuffer(file);
    if (!buffer || buffer.length === 0) {
      return apiResponse.badRequest(res, 'Failed to read uploaded file');
    }

    // Cross-validate actual file bytes against the declared MIME — prevents polyglot
    // files (e.g. ZIP claiming image/jpeg) from reaching the VLM pipeline.
    if (!magicBytesMatchMime(buffer, mimeType)) {
      return apiResponse.badRequest(res, 'File content does not match declared type');
    }

    // Charged only for a request that will start a read, so a 400 above costs no unit. No refund of the unused
    // unit: the read runs after COMMIT, where use cannot be recorded (quotaCallerCensus).
    if (!(await checkAiRateLimit(req, companyId, 'vlm-extract', { companyMax: 30, dailyMax: 300 }))) {
      return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
    }

    const registered = registerVlmExtractJob(companyId, user?.id ?? '');
    if ('refused' in registered) {
      return apiResponse.tooManyRequests(res, 'Too many scans are running — wait for one to finish and try again.');
    }
    const { jobId } = registered;

    log.info('VLM extract-only request', {
      fileName: file.originalFilename,
      fileSize: file.size,
      mimeType,
      jobId,
    }, 'vlm-extract');

    runAfterCommit('vlm-extract', () => runVlmExtractJob(jobId, () => readUploadedDocument(buffer, mimeType)));

    return apiResponse.success(res, { jobId }, undefined, 202);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('VLM extract failed', { error: msg }, 'vlm-extract');
    return apiResponse.internalError(res, err, `Extraction failed: ${msg}`);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
