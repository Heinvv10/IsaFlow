/**
 * Recurring Transactions API — WS-8.4
 * GET    — list templates
 * POST   — create template
 * PUT    — update template (body includes id)
 * DELETE — delete template (?id=X)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getRecurringTemplates,
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
} from '@/modules/accounting/services/recurringTransactionService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const items = await getRecurringTemplates(companyId);
    return apiResponse.success(res, items);
  }

  if (req.method === 'POST') {
    const { name, entityType, templateData, frequency, nextRunDate, isActive, autoPost } = req.body as {
      name?: string;
      entityType?: string;
      templateData?: Record<string, unknown>;
      frequency?: string;
      nextRunDate?: string;
      isActive?: boolean;
      autoPost?: boolean;
    };
    if (!name || !entityType || !templateData || !frequency) {
      return apiResponse.badRequest(res, 'name, entityType, templateData, and frequency are required');
    }
    const userId = req.user.id;
    try {
      const item = await createRecurringTemplate(companyId, userId, {
        name,
        entityType: entityType as Parameters<typeof createRecurringTemplate>[2]['entityType'],
        templateData,
        frequency: frequency as Parameters<typeof createRecurringTemplate>[2]['frequency'],
        nextRunDate,
        isActive,
        autoPost,
      });
      return apiResponse.success(res, item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Recurring template create failed', { error: err }, 'recurring-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body as { id?: string; [key: string]: unknown };
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      const item = await updateRecurringTemplate(
        companyId, id,
        updates as Parameters<typeof updateRecurringTemplate>[2],
      );
      return apiResponse.success(res, item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      log.error('Recurring template update failed', { error: err }, 'recurring-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string;
    if (!id) return apiResponse.badRequest(res, 'id query param is required');
    try {
      await deleteRecurringTemplate(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      log.error('Recurring template delete failed', { error: err }, 'recurring-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
