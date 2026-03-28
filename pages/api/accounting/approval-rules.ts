/**
 * Approval Rules API
 * GET  — list all rules
 * POST — create a new rule
 * PUT  — update a rule
 * DELETE — delete a rule
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { listRules, createRule, updateRule, deleteRule } from '@/modules/accounting/services/approvalService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const rules = await listRules(companyId);
    return apiResponse.success(res, { items: rules });
  }

  if (req.method === 'POST') {
    const { name, documentType, conditionField, conditionOperator, conditionValue, approverRole } = req.body;
    if (!name || !documentType) {
      return apiResponse.badRequest(res, 'name and documentType are required');
    }
    const rule = await createRule(companyId, { name, documentType, conditionField, conditionOperator, conditionValue, approverRole });
    return apiResponse.success(res, rule);
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const rule = await updateRule(companyId, id, updates);
    return apiResponse.success(res, rule);
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string || req.body.id;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    await deleteRule(companyId, id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
