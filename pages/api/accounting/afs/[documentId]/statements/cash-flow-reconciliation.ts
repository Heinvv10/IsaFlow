import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  const { companyId } = req;
  const { documentId, period_start, period_end } = req.query;

  if (!documentId || typeof documentId !== 'string') return apiResponse.badRequest(res, 'documentId is required');
  if (!period_start || typeof period_start !== 'string') return apiResponse.badRequest(res, 'period_start is required (YYYY-MM-DD)');
  if (!period_end || typeof period_end !== 'string') return apiResponse.badRequest(res, 'period_end is required (YYYY-MM-DD)');

  log.info('Generating cash flow reconciliation', { companyId, documentId, period_start, period_end }, 'accounting');
  const reconciliation = await getCashFlowReconciliation(companyId, period_start, period_end);
  return apiResponse.success(res, { reconciliation });
}

export default withCompany(withErrorHandler(handler as never));
