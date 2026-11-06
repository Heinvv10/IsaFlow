/**
 * Cash Flow Statement Export API
 * GET — export cash flow statement as CSV
 *
 * The cash flow data is the same service the screen reads (cashFlowIndirectService), so the two cannot differ.
 *
 * Query params:
 *   period_start   YYYY-MM-DD  required
 *   period_end     YYYY-MM-DD  required
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { csvVal } from '@/lib/csv';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  const { companyId } = req as CompanyAuthedRequest;

  // Deliberately BEFORE the period checks below: a request naming a cost centre is refused whatever its dates say.
  // No cost-centre cash flow: cash is held in bank accounts, which no cost centre owns. Refused, not ignored.
  if (req.query.cost_centre || req.query.cost_centre_id) {
    return apiResponse.badRequest(res, 'Cash flow cannot be reported by cost centre: cash is held in bank accounts, not by cost centre');
  }
  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  const cf = await getIndirectCashFlow(companyId, periodStart, periodEnd);

  const csvLines: string[] = ['Section,Description,Amount'];
  for (const section of cf.sections) {
    for (const item of section.items) {
      csvLines.push(`${csvVal(section.section)},${csvVal(item.label)},${item.amount.toFixed(2)}`);
    }
    csvLines.push(`${csvVal(section.section)},${csvVal(`Total ${section.section}`)},${section.total.toFixed(2)}`);
  }
  csvLines.push(
    `${csvVal('Summary')},${csvVal('Net Cash Flow')},${cf.netChange.toFixed(2)}`,
    `${csvVal('Summary')},${csvVal('Opening Balance')},${cf.openingCash.toFixed(2)}`,
    `${csvVal('Summary')},${csvVal('Closing Balance')},${cf.closingCash.toFixed(2)}`,
  );

  const csv = csvLines.join('\n');
  const filename = `cash-flow-${new Date().toISOString().split('T')[0]}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
