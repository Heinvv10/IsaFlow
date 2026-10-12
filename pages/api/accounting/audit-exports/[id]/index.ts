/**
 * /api/accounting/audit-exports/[id]
 *   GET — export metadata + current status (owner / admin / manager)
 *   GET ?verify=1 — re-read the stored ZIP: every file against its manifest hash, and the snapshot the manifest cites
 *                   verified from its stored rows (forensic-controls step 4)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getExport } from '@/modules/accounting/services/capture/auditTrailExportService';
import { verifyPack } from '@/modules/accounting/services/audit/packExport';
import { mayReadAudit, respondAuditRefusal } from '@/modules/accounting/services/audit/auditAccess';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Audit export', id);

  const row = await getExport(id, companyId);
  if (!mayReadAudit(req.companyRole)) return apiResponse.forbidden(res, 'Only an owner, admin or manager can see audit packs.');
  if (!row) return apiResponse.notFound(res, 'Audit export', id);
  if (req.query.verify === '1') {
    if (!row.snapshotId) return apiResponse.badRequest(res, 'This pack was not built from a snapshot; there is no seal to verify.');
    try {
      return apiResponse.success(res, { verification: await verifyPack(companyId, id) });
    } catch (err) {
      if (respondAuditRefusal(res, err)) return;
      throw err;
    }
  }
  return apiResponse.success(res, { export: row });
}

export default withAuth(withErrorHandler(handler));
