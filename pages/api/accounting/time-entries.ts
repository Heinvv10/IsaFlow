/**
 * Time Entries API
 * GET  — list entries (with filters) or single (?id=)
 * POST — create entry
 * PUT  — update entry
 * DELETE — delete entry
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getTimeEntries,
  getTimeEntry,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
} from '@/modules/accounting/services/timeTrackingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { id, userId, customerId, projectName, status, billable, dateFrom, dateTo, limit, offset } = req.query;

    if (id) {
      const entry = await getTimeEntry(companyId, id as string);
      if (!entry) return apiResponse.notFound(res, 'Time entry not found');
      return apiResponse.success(res, entry);
    }

    const result = await getTimeEntries(companyId, {
      userId: userId as string,
      customerId: customerId as string,
      projectName: projectName as string,
      status: status as string,
      billable: billable !== undefined ? billable === 'true' : undefined,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;
    try {
      const entry = await createTimeEntry(companyId, req.body, userId);
      return apiResponse.created(res, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      log.error('Time entry create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'PUT') {
    try {
      const { id, ...input } = req.body;
      if (!id) return apiResponse.badRequest(res, 'id is required');
      const entry = await updateTimeEntry(companyId, id, input);
      return apiResponse.success(res, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      log.error('Time entry update failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { id } = req.query;
      if (!id) return apiResponse.badRequest(res, 'id query param is required');
      await deleteTimeEntry(companyId, id as string);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      log.error('Time entry delete failed', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, msg);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
