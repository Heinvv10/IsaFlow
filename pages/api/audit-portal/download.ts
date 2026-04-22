/**
 * GET /api/audit-portal/download?sessionId=...&token=...
 *
 * Read-only auditor endpoint. Validates the bearer token against the
 * bcrypt hash stored on audit_portal_sessions, then streams the PDF
 * associated with the referenced export. No company session required —
 * the auditor is not an ISAFlow user. Bumps last_used_at + use_count.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import {
  verifyPortalToken,
  getExport,
} from '@/modules/accounting/services/capture/auditTrailExportService';

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
  if (!ex || ex.status !== 'ready' || !ex.pdfStoragePath) {
    return apiResponse.notFound(res, 'Audit export', verified.exportId);
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="audit-pack-${ex.id}.pdf"`);
  res.setHeader('X-Content-SHA256', ex.pdfSha256 ?? '');

  // HEAD — validate access + surface headers without hitting object storage
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }

  const bucket = (ex as unknown as { pdfStorageBucket?: string }).pdfStorageBucket
    ?? process.env.SUPABASE_CAPTURED_DOCS_BUCKET
    ?? 'captured-documents';
  const pdf = await downloadCapturedDocument(bucket, ex.pdfStoragePath);
  res.status(200).send(pdf);
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
