/**
 * GET /api/accounting/audit-exports/[id]/download
 * Streams the signed PDF to the requesting company user.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import { getExport } from '@/modules/accounting/services/capture/auditTrailExportService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Audit export', id);

  const row = await getExport(id, companyId);
  if (!row) return apiResponse.notFound(res, 'Audit export', id);
  if (row.status !== 'ready' || !row.pdfStoragePath) {
    return apiResponse.badRequest(res, `Export is ${row.status} — not downloadable`);
  }

  const bucket = (row as unknown as { pdfStorageBucket?: string }).pdfStorageBucket
    ?? process.env.SUPABASE_CAPTURED_DOCS_BUCKET
    ?? 'captured-documents';
  const pdf = await downloadCapturedDocument(bucket, row.pdfStoragePath);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="audit-pack-${id}.pdf"`);
  res.setHeader('X-Content-SHA256', row.pdfSha256 ?? '');
  res.status(200).send(pdf);
}

export default withAuth(withErrorHandler(handler));
