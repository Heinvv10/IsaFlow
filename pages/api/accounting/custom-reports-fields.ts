/**
 * Custom Report Fields API
 * GET /api/accounting/custom-reports-fields?source=gl_transactions
 * Returns available fields for a data source
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { getAvailableFields } from '@/modules/accounting/services/customReportService';

const VALID_SOURCES = [
  'gl_transactions', 'customer_invoices', 'supplier_invoices',
  'bank_transactions', 'items', 'customers', 'suppliers',
];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const source = String(req.query.source ?? '');
  if (!source) return apiResponse.badRequest(res, 'source query parameter is required');
  if (!VALID_SOURCES.includes(source)) {
    return apiResponse.badRequest(res, `Invalid source. Valid values: ${VALID_SOURCES.join(', ')}`);
  }

  const fields = getAvailableFields(source).map(f => ({
    field: f.field,
    label: f.label,
    type: f.type,
    sortable: f.sortable,
    filterable: f.filterable,
    totalable: f.totalable,
  }));

  return apiResponse.success(res, { source, fields });
}

export default withCompany(withErrorHandler(handler as never));
