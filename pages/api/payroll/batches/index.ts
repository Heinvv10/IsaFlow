/**
 * Payroll Batches API
 * GET  /api/payroll/batches  - list batches (optional ?status=, ?batchType=, ?periodYear=, ?periodMonth=)
 * POST /api/payroll/batches  - create a new batch (draft)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  createBatch,
  listBatches,
  type BatchStatus,
  type BatchType,
} from '@/modules/accounting/services/payroll/payrollBatchService';

const CreateBody = z
  .object({
    batchType: z.enum(['component_values', 'reimbursive_travel']),
    componentId: z.string().uuid().optional(),
    description: z.string().min(1).max(200),
    periodYear: z.number().int().min(2000).max(2100),
    periodMonth: z.number().int().min(1).max(12),
    isRecurring: z.boolean().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const status = typeof req.query.status === 'string' ? (req.query.status as BatchStatus) : undefined;
    const batchType = typeof req.query.batchType === 'string' ? (req.query.batchType as BatchType) : undefined;
    const periodYear = req.query.periodYear ? Number(req.query.periodYear) : undefined;
    const periodMonth = req.query.periodMonth ? Number(req.query.periodMonth) : undefined;
    const batches = await listBatches(companyId, { status, batchType, periodYear, periodMonth });
    return apiResponse.success(res, batches);
  }

  if (req.method === 'POST') {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    }
    try {
      const batch = await createBatch({ companyId, userId: user.id, ...parsed.data });
      return apiResponse.created(res, batch);
    } catch (err) {
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
