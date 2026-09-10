/**
 * Projects API — CRUD
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertCustomerInCompany, CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { validateProject } from '@/modules/accounting/services/reports/projectAccountingService';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as CompanyAuthedRequest).companyId;

  if (req.method === 'GET') {
    const { status } = req.query;
    let rows: Row[];
    if (status) {
      rows = await sql`SELECT p.*, c.name as client_name FROM projects p LEFT JOIN customers c ON p.client_id = c.id WHERE p.company_id = ${companyId}::UUID AND p.status = ${String(status)} ORDER BY p.created_at DESC` as Row[];
    } else {
      rows = await sql`SELECT p.*, c.name as client_name FROM projects p LEFT JOIN customers c ON p.client_id = c.id WHERE p.company_id = ${companyId}::UUID ORDER BY p.created_at DESC LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const body = req.body;
    const validation = validateProject(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));

    // R-067: client_id is read back with the customer name joined on it.
    try {
      await assertCustomerInCompany(companyId, body.clientId);
    } catch (err) {
      if (err instanceof CustomerNotInCompanyError) return apiResponse.badRequest(res, err.message);
      throw err;
    }

    // MAX, not COUNT: projects carries UNIQUE(company_id, project_number), and
    // count is not max — after a single project was deleted every later create
    // re-issued an existing number and 23505'd permanently, since the count
    // never caught up. Concurrent creates still collide on the index and fail
    // the request rather than duplicating; there is no `project` sequence in
    // company_document_numbers to reserve from.
    const maxRes = await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(project_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
      FROM projects WHERE company_id = ${companyId}::UUID AND project_number ~ '^PROJ-[0-9]+$'
    ` as Row[];
    const projNum = `PROJ-${String(Number(maxRes[0]?.max_num ?? 0) + 1).padStart(4, '0')}`;

    const inserted = await sql`
      INSERT INTO projects (company_id, project_number, name, description, client_id, billing_method, start_date, end_date, budget_amount, created_by)
      VALUES (${companyId}::UUID, ${projNum}, ${body.name}, ${body.description || null}, ${body.clientId || null}, ${body.billingMethod || 'time_and_materials'}, ${body.startDate || null}, ${body.endDate || null}, ${body.budgetAmount || 0}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];

    log.info('Project created', { projNum, name: body.name }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
