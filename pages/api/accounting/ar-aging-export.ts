/**
 * AR Aging Export API
 * GET — export accounts receivable aging report as CSV
 *   ?as_at_date=YYYY-MM-DD   (optional, defaults to today)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getARAging } from '@/modules/accounting/services/arAgingService';

/** Escape a string value for safe embedding in a CSV cell. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyApiRequest;

  try {
    const asAtDate = req.query.as_at_date ? String(req.query.as_at_date) : undefined;

    const buckets = await getARAging(companyId, asAtDate);

    const totalCurrent = buckets.reduce((s, r) => s + r.current, 0);
    const total30 = buckets.reduce((s, r) => s + r.days30, 0);
    const total60 = buckets.reduce((s, r) => s + r.days60, 0);
    const total90 = buckets.reduce((s, r) => s + r.days90, 0);
    const total120Plus = buckets.reduce((s, r) => s + r.days120Plus, 0);
    const grandTotal = buckets.reduce((s, r) => s + r.total, 0);

    const csvLines = [
      'Customer,Current,30 Days,60 Days,90 Days,120+ Days,Total',
      ...buckets.map(r =>
        [
          csvCell(r.entityName),
          r.current.toFixed(2),
          r.days30.toFixed(2),
          r.days60.toFixed(2),
          r.days90.toFixed(2),
          r.days120Plus.toFixed(2),
          r.total.toFixed(2),
        ].join(',')
      ),
      [
        csvCell('TOTALS'),
        totalCurrent.toFixed(2),
        total30.toFixed(2),
        total60.toFixed(2),
        total90.toFixed(2),
        total120Plus.toFixed(2),
        grandTotal.toFixed(2),
      ].join(','),
    ];

    const csv = csvLines.join('\n');
    const filename = `ar-aging-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export AR aging', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export AR aging');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
