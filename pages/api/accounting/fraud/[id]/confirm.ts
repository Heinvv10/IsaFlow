/** POST /api/accounting/fraud/[id]/confirm */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { confirmAlert } from '@/modules/accounting/services/capture/supplierGraphService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  const userId = req.user?.id ?? '';
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Fraud alert', id);
  if (!userId) return apiResponse.unauthorized(res);
  const ok = await confirmAlert(id, companyId, userId);
  if (!ok) return apiResponse.notFound(res, 'Fraud alert', id);
  return apiResponse.success(res, { confirmed: true });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
