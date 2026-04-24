/**
 * POST /api/payroll/batches/:id/lines
 * Body: { lines: [{ employeeId, value?, km?, ratePerKm?, taxablePortion?, nonTaxablePortion?, effectiveFrom, effectiveTo?, notes? }, ...] }
 *
 * Upserts (batch_id, employee_id) — so re-posting the same employee overwrites.
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
  addBatchLines,
  BatchNotFoundError,
  BatchNotEditableError,
} from '@/modules/accounting/services/payroll/payrollBatchService';

const LineSchema = z
  .object({
    employeeId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "Invalid UUID" }),
    value: z.number().finite().optional(),
    km: z.number().finite().positive().optional(),
    ratePerKm: z.number().finite().positive().optional(),
    taxablePortion: z.number().finite().nonnegative().optional(),
    nonTaxablePortion: z.number().finite().nonnegative().optional(),
    effectiveFrom: z.string(),
    effectiveTo: z.string().optional().nullable(),
    notes: z.string().max(500).optional(),
  })
  .strict();

const Body = z.object({ lines: z.array(LineSchema).min(1).max(500) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing batch id');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
  }

  try {
    const result = await addBatchLines(
      companyId,
      id,
      parsed.data.lines.map((l) => ({
        ...l,
        effectiveFrom: new Date(l.effectiveFrom),
        effectiveTo: l.effectiveTo ? new Date(l.effectiveTo) : null,
      })),
    );
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof BatchNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof BatchNotEditableError) return apiResponse.badRequest(res, err.message);
    return apiResponse.badRequestFromError(res, err, 'Add lines failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
