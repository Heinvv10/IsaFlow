/**
 * GET  /api/payroll/training-events?year=&employeeId=
 * POST /api/payroll/training-events
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  createTrainingEvent,
  listTrainingEvents,
  type TrainingCategory,
} from '@/modules/accounting/services/payroll/trainingEventService';

const CATEGORIES = [
  'aet', 'learnership', 'skills_programme', 'internship',
  'bursary', 'short_course', 'workshop', 'other',
] as const;

const CreateBody = z
  .object({
    employeeId: z.string().uuid(),
    category: z.enum(CATEGORIES),
    description: z.string().min(1).max(500),
    provider: z.string().max(200).optional(),
    nqfLevel: z.number().int().min(1).max(10).optional(),
    plannedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    plannedEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    costPlanned: z.number().nonnegative(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

function getHandler(): (req: AuthenticatedNextApiRequest, res: NextApiResponse) => Promise<void> {
  return async (req, res) => {
    const { companyId, user } = req as CompanyAuthedRequest;

    if (req.method === 'GET') {
      const opts: { year?: number; employeeId?: string } = {};
      if (typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year)) {
        opts.year = Number(req.query.year);
      }
      if (typeof req.query.employeeId === 'string' && req.query.employeeId) {
        opts.employeeId = req.query.employeeId;
      }
      const rows = await listTrainingEvents(companyId, opts);
      return apiResponse.success(res, rows);
    }

    if (req.method === 'POST') {
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      try {
        const evt = await createTrainingEvent({
          companyId,
          employeeId: parsed.data.employeeId,
          category: parsed.data.category as TrainingCategory,
          description: parsed.data.description,
          ...(parsed.data.provider !== undefined && { provider: parsed.data.provider }),
          ...(parsed.data.nqfLevel !== undefined && { nqfLevel: parsed.data.nqfLevel }),
          ...(parsed.data.plannedStart !== undefined && { plannedStart: parsed.data.plannedStart }),
          ...(parsed.data.plannedEnd !== undefined && { plannedEnd: parsed.data.plannedEnd }),
          costPlanned: parsed.data.costPlanned,
          ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
          userId: user.id,
        });
        return apiResponse.created(res, evt);
      } catch (err) {
        return apiResponse.badRequestFromError(res, err, 'Create failed');
      }
    }

    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
  };
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(getHandler()))));
