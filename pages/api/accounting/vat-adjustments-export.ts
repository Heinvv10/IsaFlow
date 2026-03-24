/**
 * VAT Adjustments Export API
 * GET — export VAT adjustments as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { neon } from '@neondatabase/serverless';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';

const sql = neon(process.env.DATABASE_URL!);

function csvCell(v: string): string { return `"${String(v || '').replace(/"/g, '""')}"`; }

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const rows = await sql`
      SELECT adjustment_number, adjustment_date, vat_period,
        adjustment_type, amount, reason, status
      FROM vat_adjustments ORDER BY adjustment_date DESC
    `;

    const csvLines = [
      'Adjustment No,Date,VAT Period,Type,Amount,Reason,Status',
      ...rows.map((r: Record<string, unknown>) => [
        csvCell(String(r.adjustment_number)),
        csvCell(String(r.adjustment_date)),
        csvCell(String(r.vat_period || '')),
        csvCell(String(r.adjustment_type)),
        Number(r.amount || 0).toFixed(2),
        csvCell(String(r.reason || '')),
        csvCell(String(r.status)),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="vat-adjustments-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('VAT adjustments export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export VAT adjustments');
  }
}

export default withAuth(handler);
