/**
 * Sales Reps API
 * GET  — List sales reps
 * POST — Create sales rep
 * PUT  — Update sales rep
 * DELETE — Delete sales rep
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT id, name, email, phone, is_active, created_at
      FROM sales_reps WHERE company_id = ${companyId}
      ORDER BY name ASC
    `) as Row[];
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const { name, email, phone } = req.body as { name?: string; email?: string; phone?: string };
    if (!name?.trim()) return apiResponse.badRequest(res, 'Name is required');
    const [row] = (await sql`
      INSERT INTO sales_reps (company_id, name, email, phone)
      VALUES (${companyId}, ${name.trim()}, ${email?.trim() || null}, ${phone?.trim() || null})
      RETURNING *
    `) as Row[];
    return apiResponse.created(res, row);
  }

  if (req.method === 'PUT') {
    const { id, name, email, phone, is_active } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const [row] = (await sql`
      UPDATE sales_reps SET
        name = COALESCE(${name ?? null}, name),
        email = COALESCE(${email ?? null}, email),
        phone = COALESCE(${phone ?? null}, phone),
        is_active = COALESCE(${is_active ?? null}, is_active)
      WHERE id = ${id}::uuid AND company_id = ${companyId}
      RETURNING *
    `) as Row[];
    if (!row) return apiResponse.notFound(res, 'Sales rep', id);
    return apiResponse.success(res, row);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    await sql`DELETE FROM sales_reps WHERE id = ${id}::uuid AND company_id = ${companyId}`;
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
