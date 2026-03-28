/**
 * Cost Centres Action API
 * POST — update, toggle, or delete a cost centre
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  updateCostCentre, toggleCostCentre, deleteCostCentre,
} from '@/modules/accounting/services/costCentreService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const { action, id, ...data } = req.body;
  if (!id) return apiResponse.badRequest(res, 'id required');

  try {
    switch (action) {
      case 'update': {
        const updated = await updateCostCentre(companyId, id, data);
        return apiResponse.success(res, updated);
      }
      case 'toggle':
        await toggleCostCentre(companyId, id, data.isActive !== false);
        return apiResponse.success(res, { toggled: true });
      case 'delete':
        await deleteCostCentre(companyId, id);
        return apiResponse.success(res, { deleted: true });
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Cost centre action failed', { action, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Action failed');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
