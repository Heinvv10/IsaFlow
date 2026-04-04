/**
 * Custom Report Export API
 * POST /api/accounting/custom-reports-export
 * Executes report and streams CSV download
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { runReport, type ReportConfig } from '@/modules/accounting/services/customReportService';
import { escapeCsv } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const body = req.body as ReportConfig & { reportName?: string };

  if (!body.dataSource) return apiResponse.badRequest(res, 'dataSource is required');
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return apiResponse.badRequest(res, 'At least one column is required');
  }

  const config: ReportConfig = {
    dataSource: body.dataSource,
    columns: body.columns,
    filters: body.filters ?? [],
    sortBy: body.sortBy ?? [],
    groupBy: body.groupBy ?? [],
    limit: 10000, // export all rows up to 10k
    offset: 0,
  };

  let result;
  try {
    result = await runReport(companyId, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Export failed';
    if (msg.includes('Unknown data source') || msg.includes('No valid columns')) {
      return apiResponse.badRequest(res, msg);
    }
    throw err;
  }

  const reportName = (body.reportName ?? body.dataSource).replace(/[^a-z0-9_-]/gi, '_');
  const filename = `${reportName}_${new Date().toISOString().split('T')[0]}.csv`;

  // Build CSV
  const headerRow = result.columns.map(c => escapeCsv(c.label)).join(',');
  const dataRows = result.rows.map(row =>
    result.columns.map(c => escapeCsv(row[c.field])).join(','),
  );

  // Totals row
  const hasTotals = Object.keys(result.totals).length > 0;
  let totalsRow = '';
  if (hasTotals) {
    totalsRow = '\n' + result.columns.map(c => {
      const tv = result.totals[c.field];
      if (tv !== undefined) return escapeCsv(tv.toFixed(2));
      return '';
    }).join(',');
  }

  const csv = [headerRow, ...dataRows].join('\n') + totalsRow;

  log.info('Report exported to CSV', { dataSource: config.dataSource, rowCount: result.rowCount, companyId }, 'CustomReportsExportAPI');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send('\uFEFF' + csv); // BOM for Excel compatibility
}

export default withCompany(withErrorHandler(handler as never));
