/**
 * GET /api/accounting/ar/sent-mirror/connections/[id]/log
 * Returns the last 50 scan log rows for diagnostics in the settings UI.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listSentScanLog } from '@/modules/accounting/services/ar/sentMirrorAdmin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Sent mirror connection', id);

  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const rows = await listSentScanLog(id, companyId, limit);
  return apiResponse.success(res, { items: rows, total: rows.length });
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));
