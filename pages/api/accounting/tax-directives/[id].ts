/**
 * Tax Directives API — single resource
 * GET    — get directive by id
 * PATCH  — update status (approve / cancel)
 * DELETE — remove directive
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getTaxDirective,
  updateTaxDirectiveStatus,
  deleteTaxDirective,
  type DirectiveStatus,
} from '@/modules/accounting/services/payroll/taxDirectiveService';

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
    const { status } = req.body as { status?: string };
    if (!status || !VALID_STATUSES.includes(status as DirectiveStatus)) {
      return apiResponse.badRequest(
        res,
        `status must be one of: ${VALID_STATUSES.join(', ')}`,
      );
    }

    const updated = await updateTaxDirectiveStatus(
      companyId,
      directiveId,
      status as DirectiveStatus,
      status === 'approved' ? user.id : undefined,
    );

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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
