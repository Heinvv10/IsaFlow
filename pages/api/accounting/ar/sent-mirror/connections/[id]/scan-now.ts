/**
 * POST /api/accounting/ar/sent-mirror/connections/[id]/scan-now
 * Forces a scan of the connection ignoring the interval gate. Returns the
 * per-run summary (scanned / linked / captured / skipped / errors).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { getSentConnection, scanSentConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Sent mirror connection', id);

  const conn = await getSentConnection(id, companyId);
  if (!conn) return apiResponse.notFound(res, 'Sent mirror connection', id);

  const result = await scanSentConnection(conn);
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
