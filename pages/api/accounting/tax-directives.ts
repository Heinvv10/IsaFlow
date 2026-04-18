/**
 * Tax Directives API
 * GET  /api/accounting/tax-directives          — list (optional ?status= filter)
 * POST /api/accounting/tax-directives          — create
 * PATCH /api/accounting/tax-directives?id=...  — update status
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listTaxDirectives,
  createTaxDirective,
  updateTaxDirectiveStatus,
  type TaxDirectiveInput,
} from '@/modules/accounting/services/reports/taxDirectiveService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId, user } = req;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const status = req.query.status as string | undefined;
    const directives = await listTaxDirectives(companyId, { status });
    return apiResponse.success(res, directives);
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as Partial<TaxDirectiveInput>;

    if (!body.employee_name?.trim()) {
      return apiResponse.badRequest(res, 'employee_name is required');
    }
    if (!body.directive_type) {
      return apiResponse.badRequest(res, 'directive_type is required');
    }
    if (!body.amount || isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
      return apiResponse.badRequest(res, 'amount must be a positive number');
    }
    if (!body.effective_date) {
      return apiResponse.badRequest(res, 'effective_date is required');
    }

    const input: TaxDirectiveInput = {
      employee_id: body.employee_id,
      employee_name: body.employee_name.trim(),
      employee_tax_number: body.employee_tax_number,
      directive_number: body.directive_number,
      directive_type: body.directive_type,
      amount: Number(body.amount),
      tax_rate: body.tax_rate !== undefined ? Number(body.tax_rate) : undefined,
      tax_amount: body.tax_amount !== undefined ? Number(body.tax_amount) : undefined,
      effective_date: body.effective_date,
      expiry_date: body.expiry_date,
      sars_reference: body.sars_reference,
      notes: body.notes,
    };

    const directive = await createTaxDirective(companyId, input, user.id);
    log.info('Tax directive created via API', { companyId, id: directive.id }, 'tax-directives-api');
    return apiResponse.success(res, directive, 'Tax directive created');
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id as string | undefined;
    const { status } = req.body as { status?: string };

    if (!id) return apiResponse.badRequest(res, 'id query param is required');
    if (!status) return apiResponse.badRequest(res, 'status is required');

    const directive = await updateTaxDirectiveStatus(companyId, id, status, user.id);
    return apiResponse.success(res, directive, 'Status updated');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
