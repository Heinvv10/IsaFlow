/**
 * Tax Directives API — single resource
 * GET    — get directive by id
 * PATCH  — update status (approve / cancel) and/or issued_date (YYYY-MM-DD or null).
 *          A paid directive cannot leave 'approved': 409 (taxDirectivePaidGuard).
 * DELETE — remove directive
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getTaxDirective,
  updateTaxDirective,
  deleteTaxDirective,
  TaxDirectivePaidError,
  type DirectiveStatus,
} from '@/modules/accounting/services/payroll/taxDirectiveService';
import { isIsoDate } from '@/modules/accounting/services/payroll/taxDirectiveDates';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES: DirectiveStatus[] = ['pending', 'approved', 'expired', 'cancelled'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;
  const directiveId = String(req.query.id);

  if (!UUID_RE.test(directiveId)) {
    return apiResponse.notFound(res, 'TaxDirective', directiveId);
  }

  if (req.method === 'GET') {
    const directive = await getTaxDirective(companyId, directiveId);
    if (!directive) return apiResponse.notFound(res, 'TaxDirective', directiveId);
    return apiResponse.success(res, directive);
  }

  if (req.method === 'PATCH') {
    const { status, issued_date: issuedDate } = (req.body ?? {}) as { status?: string; issued_date?: unknown };
    if (status === undefined && issuedDate === undefined) {
      return apiResponse.badRequest(res, 'Send status and/or issued_date');
    }
    if (status !== undefined && !VALID_STATUSES.includes(status as DirectiveStatus)) {
      return apiResponse.badRequest(
        res,
        `status must be one of: ${VALID_STATUSES.join(', ')}`,
      );
    }
    if (issuedDate !== undefined && issuedDate !== null && !isIsoDate(issuedDate)) {
      return apiResponse.badRequest(res, 'issued_date must be a date in YYYY-MM-DD format from 2000 to today, or null');
    }

    let updated;
    try {
      updated = await updateTaxDirective(
        companyId,
        directiveId,
        { status: status as DirectiveStatus | undefined, issued_date: issuedDate as string | null | undefined },
        status === 'approved' ? user.id : undefined,
      );
    } catch (err) {
      // Raised before anything is written, so the 409 withAuth commits changes nothing.
      if (err instanceof TaxDirectivePaidError) return apiResponse.conflict(res, err.message);
      throw err;
    }

    if (!updated) return apiResponse.notFound(res, 'TaxDirective', directiveId);
    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    const deleted = await deleteTaxDirective(companyId, directiveId);
    if (!deleted) return apiResponse.notFound(res, 'TaxDirective', directiveId);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
