/**
 * Bank Rules Action API
 * POST — delete, toggle, or apply rules
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { deleteRule, deleteRules, toggleRule, applyRules, updateRule } from '@/modules/accounting/services/bank/bankRulesService';
import { UUID } from '@/lib/schemas/common';

const BankRulesActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delete'), id: UUID }),
  z.object({ action: z.literal('deleteMany'), ids: z.array(UUID).min(1) }),
  z.object({ action: z.literal('toggle'), id: UUID, isActive: z.boolean().optional() }),
  z.object({
    action: z.literal('update'),
    id: UUID,
    name: z.string().optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
    priority: z.number().int().optional(),
    conditions: z.array(z.record(z.string(), z.unknown())).optional(),
    categoryId: z.string().optional(),
    glAccountId: z.string().optional(),
    autoApply: z.boolean().optional(),
  }),
  z.object({ action: z.literal('apply'), bankAccountId: UUID }),
]);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  const parsed = BankRulesActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const body = parsed.data;

  try {
    switch (body.action) {
      case 'delete':
        await deleteRule(companyId, body.id);
        return apiResponse.success(res, { deleted: true });

      case 'deleteMany': {
        const count = await deleteRules(companyId, body.ids);
        return apiResponse.success(res, { deleted: count });
      }

      case 'toggle':
        await toggleRule(companyId, body.id, body.isActive !== false);
        return apiResponse.success(res, { toggled: true });

      case 'update': {
        const updated = await updateRule(companyId, body.id, body);
        return apiResponse.success(res, updated);
      }

      case 'apply': {
        const result = await applyRules(companyId, body.bankAccountId, userId);
        return apiResponse.success(res, result);
      }
    }
  } catch (err) {
    log.error('Bank rules action failed', { action: body.action, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Action failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
