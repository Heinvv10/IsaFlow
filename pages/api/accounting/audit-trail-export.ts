/**
 * Audit Trail Export API
 * GET — export journal entry audit trail as CSV
 *   ?period_start=YYYY-MM-DD
 *   ?period_end=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAuditTrail } from '@/modules/accounting/services/transactionReportingService';

/** Escape a string value for safe embedding in a CSV cell. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const rows = await getAuditTrail(companyId, periodStart, periodEnd);

    const totalDebit = rows.reduce((s, r) => s + r.totalDebit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.totalCredit, 0);

    const csvLines = [
      'Entry Date,Entry Number,Description,Source,Status,Total Debit,Total Credit,Created By,Created At',
      ...rows.map(r =>
        [
          csvCell(r.entryDate),
          csvCell(r.entryNumber),
          csvCell(r.description),
          csvCell(r.source),
          csvCell(r.status),
          r.totalDebit.toFixed(2),
          r.totalCredit.toFixed(2),
          csvCell(r.createdBy),
          csvCell(r.createdAt),
        ].join(',')
      ),
      [
        csvCell(''),
        csvCell('TOTALS'),
        csvCell(''),
        csvCell(''),
        csvCell(''),
        totalDebit.toFixed(2),
        totalCredit.toFixed(2),
        csvCell(''),
        csvCell(''),
      ].join(','),
    ];

    const csv = csvLines.join('\n');
    const filename = `audit-trail-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export audit trail', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export audit trail');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
