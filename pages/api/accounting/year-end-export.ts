/**
 * Year-End Export API
 * GET — export fiscal year summaries as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

function csvCell(v: string): string { return `"${String(v || '').replace(/"/g, '""')}"`; }

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyApiRequest;

  try {
    const rows = await sql`
      SELECT fiscal_year, MIN(start_date) AS start_date, MAX(end_date) AS end_date,
        CASE WHEN COUNT(*) FILTER (WHERE status = 'open') > 0 THEN 'open' ELSE 'closed' END AS status
      FROM fiscal_periods
      WHERE company_id = ${companyId}
      GROUP BY fiscal_year
      ORDER BY fiscal_year DESC
    `;

    const csvLines = [
      'Year,Start Date,End Date,Status',
      ...rows.map((r: Record<string, unknown>) => [
        csvCell(String(r.fiscal_year)),
        csvCell(String(r.start_date)),
        csvCell(String(r.end_date)),
        csvCell(String(r.status)),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="year-end-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Year-end export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export year-end data');
  }
}

export default withCompany(handler);
