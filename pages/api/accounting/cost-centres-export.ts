/**
 * Cost Centres Export API
 * GET — export cost centres as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyApiRequest;

  try {
    const rows = await sql`
      SELECT code, name, description, department, is_active
      FROM cost_centres WHERE company_id = ${companyId} ORDER BY code
    `;

    const csvLines = [
      'Code,Name,Description,Department,Active',
      ...rows.map((r: Record<string, unknown>) => [
        csvCell(String(r.code)),
        csvCell(String(r.name)),
        csvCell(String(r.description || '')),
        csvCell(String(r.department || '')),
        r.is_active ? 'Yes' : 'No',
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="cost-centres-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Cost centres export failed', { error: err });
    return apiResponse.internalError(res, err, 'Failed to export cost centres');
  }
}

export default withCompany(withErrorHandler(handler));
