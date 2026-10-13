/**
 * GET /api/accounting/audit-exports/[id]/download
 * Streams the pack to the requesting company user: the snapshot pack's ZIP, or an older pack's PDF.
 * Owner / admin / manager only — the ZIP carries the snapshot's ledger rows, which RLS (891) shows no other role.
 * A ZIP that does not verify (file hash, sealed manifest, cited snapshot) is refused (400 PACK_REFUSED), not served.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import { exportDownload, getExport } from '@/modules/accounting/services/capture/auditTrailExportService';
import { mayReadAudit, respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';
import { verifiedPackZip } from '@/modules/accounting/services/audit/packVerify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Audit export', id);
  if (!mayReadAudit(req.companyRole)) return apiResponse.forbidden(res, 'Only an owner, admin or manager can download an audit pack.');

  const row = await getExport(id, companyId);
  if (!row) return apiResponse.notFound(res, 'Audit export', id);
  const file = exportDownload(row);
  if (!file) return apiResponse.badRequest(res, `Export is ${row.status} — not downloadable`);
  let bytes: Buffer;
  try {
    // A snapshot pack's ZIP is served only when its sealed manifest verifies; an older PDF-only pack has no seal.
    bytes = file.contentType === 'application/zip' ? await verifiedPackZip(companyId, row) : await downloadCapturedDocument(file.bucket, file.path);
  } catch (err) {
    if (respondAuditRefusal(res, err)) return;
    throw err;
  }
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('X-Content-SHA256', file.sha256);
  res.status(200).send(bytes);
}

export default withAuth(withErrorHandler(handler));
