/**
 * Bank Rules Action API
 * POST — delete, toggle, or apply rules
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { deleteRule, deleteRules, toggleRule, applyRules, updateRule } from '@/modules/accounting/services/bankRulesService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { action, id, ids, isActive, bankAccountId } = req.body;

  try {
    switch (action) {
      case 'delete':
        if (!id) return apiResponse.badRequest(res, 'id required');
        await deleteRule(companyId, id);
        return apiResponse.success(res, { deleted: true });

      case 'deleteMany': {
        if (!Array.isArray(ids) || ids.length === 0) return apiResponse.badRequest(res, 'ids array required');
        const count = await deleteRules(companyId, ids);
        return apiResponse.success(res, { deleted: count });
      }

      case 'toggle':
        if (!id) return apiResponse.badRequest(res, 'id required');
        await toggleRule(companyId, id, isActive !== false);
        return apiResponse.success(res, { toggled: true });

      case 'update': {
        if (!id) return apiResponse.badRequest(res, 'id required');
        const updated = await updateRule(companyId, id, req.body);
        return apiResponse.success(res, updated);
      }

      case 'apply': {
        if (!bankAccountId) return apiResponse.badRequest(res, 'bankAccountId required');
        const result = await applyRules(companyId, bankAccountId, userId);
        return apiResponse.success(res, result);
      }

      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    log.error('Bank rules action failed', { action, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Action failed');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
