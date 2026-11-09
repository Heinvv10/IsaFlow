/**
 * GET   /api/payroll/employees/:id/fringe-benefits  - the employee's vehicle / travel-allowance inputs, newest first
 * POST  /api/payroll/employees/:id/fringe-benefits  - record one (kind, dates, determined value, maintenance plan, business use)
 * PATCH /api/payroll/employees/:id/fringe-benefits  - end one: { benefitId, effectiveTo }
 *
 * Payroll-detail roles only (owner/admin/manager); another company's employee is 404; no-store. A refused body
 * writes nothing: every refusal is thrown before the first write (fringeBenefitService).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { isRealIsoDay } from '@/modules/accounting/services/payroll/fringeBenefits';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import {
  createFringeBenefit,
  endFringeBenefit,
  FringeBenefitRefused,
  listFringeBenefits,
} from '@/modules/accounting/services/payroll/fringeBenefitService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealIsoDay, 'Not a real date');
// Whole cents: 400000.005 is refused, not rounded.
const cents = z.number().min(0.01).max(99_999_999_999).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most two decimals');

const CreateBody = z.object({
  kind: z.enum(['company_vehicle', 'travel_allowance']),
  determinedValue: cents.nullable().optional(),
  maintenancePlan: z.boolean().optional(),
  businessUseAtLeast80: z.boolean(),
  effectiveFrom: day,
  effectiveTo: day.nullable().optional(),
}).strict();

const EndBody = z.object({ benefitId: z.string().regex(UUID, 'Invalid UUID'), effectiveTo: day }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;
  const employeeId = req.query.id;
  if (typeof employeeId !== 'string' || !UUID.test(employeeId)) return apiResponse.badRequest(res, 'id must be a UUID');
  const actor = { userId: user.id, userEmail: user.email, channel: 'rest' as const };

  if (req.method === 'GET') {
    if (!(await checkReportRateLimit(companyId, `fringe-benefits:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
      log.warn('Fringe benefits rate limit exceeded', { companyId, userId: user.id }, 'fringe-benefits');
      return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
    }
    const list = await listFringeBenefits(companyId, employeeId);
    if (!list) return apiResponse.notFound(res, 'Employee');
    return apiResponse.success(res, list);
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const own = await listFringeBenefits(companyId, employeeId);
    if (!own) return apiResponse.notFound(res, 'Employee');
    try {
      if (req.method === 'POST') {
        const parsed = CreateBody.safeParse(req.body);
        if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
        const b = parsed.data;
        const created = await createFringeBenefit(companyId, employeeId, {
          kind: b.kind, determinedValue: b.determinedValue ?? null, maintenancePlan: b.maintenancePlan ?? false,
          businessUseAtLeast80: b.businessUseAtLeast80, effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo ?? null,
        }, actor);
        return apiResponse.created(res, created);
      }
      const parsed = EndBody.safeParse(req.body);
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      const ended = await endFringeBenefit(companyId, employeeId, parsed.data.benefitId, parsed.data.effectiveTo, actor);
      if (!ended) return apiResponse.notFound(res, 'Fringe benefit');
      return apiResponse.success(res, { ended: true });
    } catch (err) {
      if (err instanceof FringeBenefitRefused) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH']);
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
