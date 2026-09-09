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
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { listRules, createRule, updateRule, deleteRule, isConditionOperator, CONDITION_OPERATORS, ApprovalRoleInvalidError } from '@/modules/accounting/services/gl/approvalService';

const OPERATOR_ERROR = `conditionOperator must be one of: ${CONDITION_OPERATORS.join(', ')}`;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const rules = await listRules(companyId);
    return apiResponse.success(res, { items: rules });
  }

  if (req.method === 'POST') {
    const { name, documentType, conditionField, conditionOperator, conditionValue, approverRole } = req.body;
    if (!name || !documentType) {
      return apiResponse.badRequest(res, 'name and documentType are required');
    }
    // Anything checkApproval cannot evaluate must not reach the column.
    if (conditionOperator !== undefined && !isConditionOperator(conditionOperator)) {
      return apiResponse.badRequest(res, OPERATOR_ERROR);
    }
    try {
      const rule = await createRule(companyId, { name, documentType, conditionField, conditionOperator, conditionValue, approverRole });
      return apiResponse.success(res, rule);
    } catch (error) {
      if (error instanceof ApprovalRoleInvalidError) return apiResponse.badRequest(res, error.message);
      throw error;
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    if (updates.conditionOperator !== undefined && !isConditionOperator(updates.conditionOperator)) {
      return apiResponse.badRequest(res, OPERATOR_ERROR);
    }
    try {
      const rule = await updateRule(companyId, id, updates);
      return apiResponse.success(res, rule);
    } catch (error) {
      if (error instanceof ApprovalRoleInvalidError) return apiResponse.badRequest(res, error.message);
      throw error;
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string || req.body.id;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    await deleteRule(companyId, id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
