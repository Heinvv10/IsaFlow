/**
 * POST /api/accounting/capture/mirror/[id]/scan-now
 * Fires a one-off scan of the connection ignoring the interval gate.
 * Returns the scan summary (scanned / ingested / skipped / errors).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { getConnection, scanConnection } from '@/modules/accounting/services/capture/imapMirrorService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Mirror connection', id);

  const conn = await getConnection(id, companyId);
  if (!conn) return apiResponse.notFound(res, 'Mirror connection', id);

  const result = await scanConnection(conn);
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
