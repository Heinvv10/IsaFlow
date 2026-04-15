/**
 * Customer Invoice Adjacent Navigation API
 * GET /api/accounting/customer-invoices-adjacent?id=<invoiceId>
 * Returns { prevId, nextId } for record navigation (Sage parity).
 * Uses a window function over invoice_date DESC order, scoped to company_id.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface WindowRow {
  id: string;
  prev_id: string | null;
  next_id: string | null;
}

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return apiResponse.badRequest(res, 'id query parameter is required');
  }

  try {
    const rows = (await sql`
      SELECT id, prev_id, next_id
      FROM (
        SELECT
          id,
          LAG(id)  OVER (ORDER BY invoice_date DESC, id) AS prev_id,
          LEAD(id) OVER (ORDER BY invoice_date DESC, id) AS next_id
        FROM customer_invoices
        WHERE company_id = ${companyId}
          AND deleted_at IS NULL
      ) windowed
      WHERE id = ${id}
    `) as WindowRow[];

    if (rows.length === 0) {
      return apiResponse.notFound(res, 'Invoice not found');
    }

    const row = rows[0]!;
    return apiResponse.success(res, {
      prevId: row.prev_id ?? null,
      nextId: row.next_id ?? null,
    });
  } catch (err) {
    log.error('Failed to fetch adjacent invoice IDs', { error: err, id }, 'customer-invoices-adjacent');
    return apiResponse.internalError(res, 'Failed to fetch adjacent invoice IDs');
  }
}

export default withCompany(withErrorHandler(handler));
