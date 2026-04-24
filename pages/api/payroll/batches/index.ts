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
    componentId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "Invalid UUID" }).optional(),
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
    // Pentest M17: bound numeric query params — POST path uses Zod with
    // equivalent ranges, GET was unguarded.
    let periodYear: number | undefined;
    if (req.query.periodYear) {
      const y = Number(req.query.periodYear);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        return apiResponse.badRequest(res, 'periodYear must be an integer between 2000 and 2100');
      }
      periodYear = y;
    }
    let periodMonth: number | undefined;
    if (req.query.periodMonth) {
      const m = Number(req.query.periodMonth);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return apiResponse.badRequest(res, 'periodMonth must be an integer between 1 and 12');
      }
      periodMonth = m;
    }
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
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
