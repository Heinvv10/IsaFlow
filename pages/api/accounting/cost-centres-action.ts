/**
 * Cost Centres Action API
 * POST — update, toggle, or delete a cost centre.
 *
 * update and toggle go through the dimension master edit (ladder, alias and
 * FNO-move rules); delete through the counted usage guard.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { CostCentreActionError } from '@/modules/accounting/services/core/costCentreUsageGuard';
import { deleteCostCentre } from '@/modules/accounting/services/core/costCentreService';
import {
  applyUpdateDimensionCostCentre, planUpdateDimensionCostCentre, type UpdateDimensionCostCentreInput,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

/** The form's fields: absent = unchanged, '' = clear (parent detaches). */
function updateInput(data: Record<string, unknown>): UpdateDimensionCostCentreInput {
  const text = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : undefined);
  const parent = text('parent');
  return {
    code: text('code'), name: text('name'), description: text('description'), department: text('department'),
    ...(parent !== undefined ? { parent: parent.trim() ? parent : null } : {}),
    ...(Array.isArray(data.aliases) ? { aliases: (data.aliases as unknown[]).filter((a): a is string => typeof a === 'string') } : {}),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { action, id, ...data } = req.body;
  if (!id) return apiResponse.badRequest(res, 'id required');

  try {
    switch (action) {
      case 'update': {
        const plan = await planUpdateDimensionCostCentre(companyId, String(id), updateInput(data));
        await applyUpdateDimensionCostCentre(companyId, plan, userId);
        return apiResponse.success(res, { id: plan.before.id, ...plan.after, changed: plan.changed, warnings: plan.warnings });
      }
      case 'toggle': {
        const plan = await planUpdateDimensionCostCentre(companyId, String(id), { isActive: data.isActive !== false });
        await applyUpdateDimensionCostCentre(companyId, plan, userId);
        return apiResponse.success(res, { toggled: true });
      }
      case 'delete':
        await deleteCostCentre(companyId, id);
        return apiResponse.success(res, { deleted: true });
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Cost centre action failed', { action, error: err }, 'accounting-api');
    // The guard's counted refusal is written for the operator; everything else
    // stays generic so internal detail cannot leak (pentest H16).
    if (err instanceof CostCentreActionError || isDimensionRefusal(err)) return apiResponse.badRequest(res, err.message);
    return apiResponse.badRequestFromError(res, err, 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
