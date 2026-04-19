/**
 * Tax Directives API — collection
 * GET  — list directives (?status=, ?search=)
 * POST — create a new directive
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listTaxDirectives,
  createTaxDirective,
  type TaxDirectiveCreateInput,
  type DirectiveStatus,
} from '@/modules/accounting/services/payroll/taxDirectiveService';

const VALID_TYPES = ['lump_sum', 'retirement', 'severance', 'death'] as const;
const VALID_STATUSES = ['pending', 'approved', 'expired', 'cancelled'] as const;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const status =
      req.query.status && VALID_STATUSES.includes(req.query.status as DirectiveStatus)
        ? (req.query.status as DirectiveStatus)
        : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    const directives = await listTaxDirectives(companyId, { status, search });
    return apiResponse.success(res, directives);
  }

  if (req.method === 'POST') {
    const body = req.body as Partial<TaxDirectiveCreateInput>;

    if (!body.employee_name?.trim()) {
      return apiResponse.badRequest(res, 'employee_name is required');
    }
    if (!body.directive_type || !VALID_TYPES.includes(body.directive_type)) {
      return apiResponse.badRequest(
        res,
        `directive_type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }
    if (body.amount == null || isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
      return apiResponse.badRequest(res, 'amount must be a positive number');
    }
    if (!body.effective_date) {
      return apiResponse.badRequest(res, 'effective_date is required');
    }

    const input: TaxDirectiveCreateInput = {
      employee_id: body.employee_id,
      employee_name: body.employee_name.trim(),
      employee_tax_number: body.employee_tax_number,
      directive_number: body.directive_number,
      directive_type: body.directive_type,
      amount: Number(body.amount),
      tax_rate: body.tax_rate != null ? Number(body.tax_rate) : undefined,
      effective_date: body.effective_date,
      expiry_date: body.expiry_date,
      sars_reference: body.sars_reference,
      notes: body.notes,
    };

    const directive = await createTaxDirective(companyId, input, user.id);
    return apiResponse.created(res, directive);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
