/**
 * Supplier Categories API
 * GET: List categories with supplier count
 * POST: Create category
 * PUT: Update category
 * DELETE: Remove category
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  try {
    if (req.method === 'GET') {
      const rows = (await sql`
        SELECT sc.id, sc.name, sc.description, sc.created_at,
               COUNT(s.id)::int AS supplier_count
        FROM supplier_categories sc
        LEFT JOIN suppliers s ON LOWER(s.category) = LOWER(sc.name) AND s.company_id = ${companyId}
        WHERE sc.company_id = ${companyId}
        GROUP BY sc.id
        ORDER BY sc.name
      `) as Row[];
      return apiResponse.success(res, rows.map((r: Row) => ({
        id: r.id, name: r.name, description: r.description || '',
        supplierCount: Number(r.supplier_count) || 0,
      })));
    }

    if (req.method === 'POST') {
      const { name, description } = req.body;
      if (!name?.trim()) return apiResponse.badRequest(res, 'Name is required');
      const rows = (await sql`
        INSERT INTO supplier_categories (company_id, name, description)
        VALUES (${companyId}, ${name.trim()}, ${description || ''})
        RETURNING id, name, description
      `) as Row[];
      return apiResponse.success(res, rows[0]);
    }

    if (req.method === 'PUT') {
      const { id, name, description } = req.body;
      if (!id || !name?.trim()) return apiResponse.badRequest(res, 'ID and name are required');
      await sql`
        UPDATE supplier_categories
        SET name = ${name.trim()}, description = ${description || ''}
        WHERE id = ${id} AND company_id = ${companyId}
      `;
      return apiResponse.success(res, { id, name, description });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return apiResponse.badRequest(res, 'ID is required');
      await sql`DELETE FROM supplier_categories WHERE id = ${id} AND company_id = ${companyId}`;
      return apiResponse.success(res, { deleted: true });
    }

    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist')) {
      return apiResponse.success(res, []);
    }
    log.error('supplier-categories API error', { error: message });
    return apiResponse.internalError(res, err, 'Failed to process request');
  }
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
