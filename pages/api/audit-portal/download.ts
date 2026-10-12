/**
 * GET /api/audit-portal/download?sessionId=...&token=...
 *
 * Read-only auditor endpoint. Validates the bearer token against the
 * bcrypt hash stored on audit_portal_sessions, then streams the pack
 * associated with the referenced export — the snapshot pack's ZIP (only when
 * its sealed manifest verifies), or an older pack's PDF. No company session required —
 * the auditor is not an ISAFlow user. Bumps last_used_at + use_count.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import {
  verifyPortalToken,
  getExport,
  exportDownload,
} from '@/modules/accounting/services/capture/auditTrailExportService';
import { respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';
import { verifiedPackZip } from '@/modules/accounting/services/audit/packExport';
import { checkRateLimit } from '@/lib/rateLimit';

const PORTAL_DOWNLOADS_PER_MINUTE = 10;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'HEAD']);
  }
  const sessionId = req.query.sessionId as string | undefined;
  const token = req.query.token as string | undefined;
  if (!sessionId || !token) return apiResponse.badRequest(res, 'sessionId and token are required');

  const verified = await verifyPortalToken(sessionId, token);
  if (!verified) return apiResponse.unauthorized(res);

  const ex = await getExport(verified.exportId, verified.companyId);
  const file = ex ? exportDownload(ex) : null;
  if (!ex || !file) return apiResponse.notFound(res, 'Audit export', verified.exportId);

  const headers = () => {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `${file.contentType === 'application/pdf' ? 'inline' : 'attachment'}; filename="${file.filename}"`);
    res.setHeader('X-Content-SHA256', file.sha256);
  };

  // HEAD — validate access + surface headers without hitting object storage
  if (req.method === 'HEAD') {
    headers();
    res.status(200).end();
    return;
  }

  // Each download inflates and hashes the whole ZIP to verify it: bounded per auditor session.
  if (!(await checkRateLimit(`audit-portal-download:${sessionId}`, { max: PORTAL_DOWNLOADS_PER_MINUTE, windowSecs: 60 }))) {
    return apiResponse.tooManyRequests(res, 'Too many downloads of this pack in a minute; try again shortly.');
  }

  let bytes: Buffer;
  try {
    // A snapshot pack's ZIP is served only when its sealed manifest verifies: the auditor holds no key to check it.
    bytes = file.contentType === 'application/zip'
      ? await verifiedPackZip(verified.companyId, ex) : await downloadCapturedDocument(file.bucket, file.path);
  } catch (err) {
    if (respondAuditRefusal(res, err)) return;
    throw err;
  }
  headers();
  res.status(200).send(bytes);
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
