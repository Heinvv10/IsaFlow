/**
 * Bank Categorisation Rules API
 * GET  — list all rules
 * POST — create a new rule
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getRules, createRule } from '@/modules/accounting/services/bankRulesService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const rules = await getRules();
    return apiResponse.success(res, { items: rules });
  }

  if (req.method === 'POST') {
    const { ruleName, matchField, matchType, matchPattern, glAccountId, supplierId, clientId, descriptionTemplate, priority, autoCreateEntry, vatCode } = req.body;
    if (!ruleName || !matchField || !matchType || !matchPattern) {
      return apiResponse.badRequest(res, 'ruleName, matchField, matchType, and matchPattern are required');
    }
    if (!glAccountId && !supplierId && !clientId) {
      return apiResponse.badRequest(res, 'Either glAccountId, supplierId, or clientId is required');
    }
    const rule = await createRule({
      ruleName, matchField, matchType, matchPattern, glAccountId: glAccountId || undefined,
      supplierId: supplierId || undefined,
      clientId: clientId || undefined,
      descriptionTemplate: descriptionTemplate || undefined,
      priority: priority || 100,
      autoCreateEntry: autoCreateEntry !== false,
      vatCode: vatCode || 'none',
    }, userId);
    return apiResponse.success(res, rule);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
