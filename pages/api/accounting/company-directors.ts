/**
 * Company Directors API
 * GET  — list directors for the current company
 * POST — bulk create/replace directors for the current company
 * PUT  — update a single director
 * DELETE — remove a director
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth/withCompany';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface DirectorInput {
  name: string;
  idNumber?: string;
  role?: string;
  idDocument?: { name?: string; data?: string };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT id, name, id_number, role, id_document_name, created_at
      FROM company_directors
      WHERE company_id = ${companyId}::UUID
      ORDER BY created_at ASC
    `) as Row[];

    const directors = rows.map((r: Row) => ({
      id: r.id,
      name: r.name,
      idNumber: r.id_number,
      role: r.role,
      idDocumentName: r.id_document_name,
      createdAt: r.created_at,
    }));

    return apiResponse.success(res, { items: directors });
  }

  if (req.method === 'POST') {
    const { directors } = req.body as { directors?: DirectorInput[] };
    if (!Array.isArray(directors)) {
      return apiResponse.badRequest(res, 'directors array is required');
    }

    // Replace all directors for this company
    await sql`DELETE FROM company_directors WHERE company_id = ${companyId}::UUID`;

    for (const dir of directors) {
      if (!dir.name?.trim()) continue;
      await sql`
        INSERT INTO company_directors (company_id, name, id_number, role, id_document_name, id_document_data)
        VALUES (
          ${companyId}::UUID, ${dir.name.trim()}, ${dir.idNumber || null},
          ${dir.role || 'Director'}, ${dir.idDocument?.name || null}, ${dir.idDocument?.data || null}
        )
      `;
    }

    return apiResponse.success(res, { count: directors.filter(d => d.name?.trim()).length });
  }

  if (req.method === 'PUT') {
    const { id, name, idNumber, role } = req.body as { id?: string; name?: string; idNumber?: string; role?: string };
    if (!id) return apiResponse.badRequest(res, 'id is required');

    await sql`
      UPDATE company_directors
      SET name = COALESCE(${name ?? null}, name),
          id_number = COALESCE(${idNumber ?? null}, id_number),
          role = COALESCE(${role ?? null}, role)
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `;

    return apiResponse.success(res, { updated: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body as { id?: string };
    if (!id) return apiResponse.badRequest(res, 'id is required');

    await sql`DELETE FROM company_directors WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};
