/**
 * PATCH  /api/payroll/training-events/:id
 * DELETE /api/payroll/training-events/:id
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
  updateTrainingEvent,
  deleteTrainingEvent,
  TrainingEventNotFoundError,
} from '@/modules/accounting/services/payroll/trainingEventService';

const CATEGORIES = [
  'aet', 'learnership', 'skills_programme', 'internship',
  'bursary', 'short_course', 'workshop', 'other',
] as const;

const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'] as const;

const PatchBody = z
  .object({
    category: z.enum(CATEGORIES).optional(),
    description: z.string().min(1).max(500).optional(),
    provider: z.string().max(200).nullable().optional(),
    nqfLevel: z.number().int().min(1).max(10).nullable().optional(),
    plannedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    plannedEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    actualStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    actualEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    costPlanned: z.number().nonnegative().optional(),
    costActual: z.number().nonnegative().optional(),
    status: z.enum(STATUSES).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing id');

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      await updateTrainingEvent(companyId, id, parsed.data);
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      if (err instanceof TrainingEventNotFoundError) return apiResponse.notFound(res, err.message);
      throw err;
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteTrainingEvent(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      if (err instanceof TrainingEventNotFoundError) return apiResponse.notFound(res, err.message);
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
