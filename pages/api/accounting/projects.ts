/**
 * Projects API — CRUD
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateProject } from '@/modules/accounting/services/projectAccountingService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as any).companyId as string;

  if (req.method === 'GET') {
    const { status, clientId } = req.query;
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

    const countRes = await sql`SELECT COUNT(*) as cnt FROM projects WHERE company_id = ${companyId}::UUID` as Row[];
    const projNum = `PROJ-${String(Number((countRes[0] as any)?.cnt || 0) + 1).padStart(4, '0')}`;

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
export default withCompany(withErrorHandler(handler));
