/**
 * VAT Return Export API
 * GET — export VAT201 return as CSV
 *
 * Query params:
 *   period_start   YYYY-MM-DD  required
 *   period_end     YYYY-MM-DD  required
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getVATReturn } from '@/modules/accounting/services/financialReportingService';
import { csvVal } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const report = await getVATReturn(companyId, periodStart, periodEnd);

    const csvLines: string[] = [
      'Section,Box,Label,Amount',
    ];

    // Output Tax boxes
    for (const box of report.outputBoxes) {
      csvLines.push(
        `${csvVal('Output Tax')},${csvVal(box.box)},${csvVal(box.label)},${Number(box.amount).toFixed(2)}`
      );
    }
    csvLines.push(
      `${csvVal('Output Tax')},${csvVal('13')},${csvVal('Total Output Tax')},${Number(report.totalOutputTax).toFixed(2)}`
    );

    // Input Tax boxes
    for (const box of report.inputBoxes) {
      csvLines.push(
        `${csvVal('Input Tax')},${csvVal(box.box)},${csvVal(box.label)},${Number(box.amount).toFixed(2)}`
      );
    }
    csvLines.push(
      `${csvVal('Input Tax')},${csvVal('19')},${csvVal('Total Input Tax')},${Number(report.totalInputTax).toFixed(2)}`
    );

    // Net VAT payable / refundable
    csvLines.push(
      `${csvVal('Summary')},${csvVal('20')},${csvVal('Net VAT')},${Number(report.netVAT).toFixed(2)}`
    );

    const csv = csvLines.join('\n');
    const filename = `vat-return-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export VAT return', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to export VAT return');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
