import { sql } from '@/lib/neon';
/**
 * Supplier Returns / Debit Notes API
 * GET /api/accounting/supplier-returns - List returns
 * POST /api/accounting/supplier-returns - Create return/debit note
 * Sage equivalent: Suppliers > Returns
 *
 * Uses credit_notes table with type='supplier' as the backing store.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const returns = (await sql`
        SELECT
          cn.id,
          cn.credit_note_number as return_number,
          COALESCE(s.company_name, s.name, 'Unknown') as supplier_name,
          cn.supplier_invoice_id as original_invoice_id,
          cn.total_amount as amount,
          cn.status,
          cn.credit_date as return_date,
          cn.reason
        FROM credit_notes cn
        LEFT JOIN suppliers s ON s.id = cn.supplier_id
        WHERE cn.type = 'supplier' AND cn.company_id = ${companyId}
        ORDER BY cn.credit_date DESC
      `) as Row[];

      return apiResponse.success(res, { returns });
    } catch (err) {
      log.error('Failed to fetch supplier returns', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch supplier returns');
    }
  }

  if (req.method === 'POST') {
    const userId = (req as AuthenticatedNextApiRequest).user.id;
    const { supplierId, amount, reason } = req.body;

    if (!supplierId || !amount) {
      return apiResponse.validationError(res, { supplierId: 'Required', amount: 'Required' });
    }

    try {
      // Generate return number
      const countRows = (await sql`
        SELECT COUNT(*)::int as cnt FROM credit_notes WHERE type = 'supplier' AND company_id = ${companyId}
      `) as Row[];
      const countRow = countRows[0];
      const returnNum = `DR-${String(Number(countRow?.cnt ?? 0) + 1).padStart(4, '0')}`;

      const createdRows = (await sql`
        INSERT INTO credit_notes (
          id, company_id, credit_note_number, type, supplier_id,
          total_amount, reason,
          status, credit_date, created_by, created_at
        ) VALUES (
          gen_random_uuid(), ${companyId}, ${returnNum}, 'supplier', ${supplierId},
          ${amount}, ${reason || ''},
          'draft', NOW(), ${userId}, NOW()
        )
        RETURNING *
      `) as Row[];
      const created = createdRows[0];

      log.info('Supplier return created', { id: created?.id, number: returnNum, module: 'accounting' });
      return apiResponse.success(res, { return: created });
    } catch (err) {
      log.error('Failed to create supplier return', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to create supplier return');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
