/**
 * GL Lines Export API — the flat ledger file for the finance model (ledger
 * brief §4 v1 fields, §9 export contract).
 *
 * GET
 *   ?table=lines|accounts|cost_centres|business_units|counterparties  (default lines)
 *   ?date_from=YYYY-MM-DD  ?date_to=YYYY-MM-DD   (lines only; omitted = full history)
 *   ?status=all|posted                           (lines only; default all, labelled)
 *   ?manifest=1                                  (lines only; JSON summary, no rows)
 *
 * CSV, UTF-8, one file per table, header row, fixed column order. §9.2's file
 * facts travel as response headers so the CSV itself stays a pure table:
 * X-Export-Timestamp, X-Schema-Version, X-Row-Count, X-Control-Total and
 * X-Unbalanced-Txn-Count. The lines are written page by page (keyset), so full
 * history never sits in memory at once.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { hasNul, NUL_MESSAGE } from '@/lib/validation';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import {
  GL_EXPORT_TABLES,
  GL_LINE_EXPORT_COLUMNS,
  GL_LINE_EXPORT_MAX_PAGE,
  GL_LINE_EXPORT_SCHEMA_VERSION,
  csvLine,
  fetchGlLineExportPage,
  getExportDimensionTable,
  getExportEntityName,
  getGlLineExportSummary,
  isGlExportTable,
  nextCursorOf,
  toExportRow,
  type GlLineExportCursor,
  type GlLineExportOptions,
} from '@/modules/accounting/services/reports/glLineExportService';

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  if (hasNul(req.query)) return apiResponse.badRequest(res, NUL_MESSAGE);

  const { companyId } = req as CompanyAuthedRequest;
  const table = one(req.query.table) ?? 'lines';
  if (!isGlExportTable(table)) {
    return apiResponse.badRequest(res, `table must be one of ${GL_EXPORT_TABLES.join(', ')}`);
  }
  const dateFrom = one(req.query.date_from);
  const dateTo = one(req.query.date_to);
  const status = one(req.query.status) ?? 'all';
  if ((dateFrom !== undefined && !isLedgerDate(dateFrom)) || (dateTo !== undefined && !isLedgerDate(dateTo))) {
    return apiResponse.badRequest(res, `date_from and date_to ${LEDGER_DATE_MESSAGE}`);
  }
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
    return apiResponse.badRequest(res, 'date_from must not be after date_to');
  }
  if (status !== 'all' && status !== 'posted') {
    return apiResponse.badRequest(res, 'status must be all or posted');
  }

  if (!(await checkReportRateLimit(companyId, 'gl-lines-export'))) {
    log.warn('GL lines export rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many export requests. Please try again shortly.');
  }

  const exportTimestamp = new Date().toISOString();
  res.setHeader('X-Export-Timestamp', exportTimestamp);
  res.setHeader('X-Schema-Version', GL_LINE_EXPORT_SCHEMA_VERSION);

  if (table !== 'lines') {
    const dim = await getExportDimensionTable(companyId, table);
    res.setHeader('X-Row-Count', String(dim.rows.length));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gl-export-${table}.csv"`);
    res.status(200).send([dim.columns.join(','), ...dim.rows.map((r) => csvLine(dim.columns, r))].join('\n') + '\n');
    return;
  }

  const opts: GlLineExportOptions = { dateFrom, dateTo, status };
  const summary = await getGlLineExportSummary(companyId, opts);
  if (one(req.query.manifest) === '1') {
    return apiResponse.success(res, { exportTimestamp, ...summary, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null, status });
  }

  res.setHeader('X-Row-Count', String(summary.rowCount));
  res.setHeader('X-Control-Total', summary.controlTotal.toFixed(2));
  res.setHeader('X-Unbalanced-Txn-Count', String(summary.unbalancedTxnCount));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="gl-lines-${dateFrom ?? 'all'}-to-${dateTo ?? 'all'}.csv"`,
  );
  res.status(200);

  const entity = await getExportEntityName(companyId);
  res.write(GL_LINE_EXPORT_COLUMNS.join(',') + '\n');
  let cursor: GlLineExportCursor | null = null;
  let written = 0;
  do {
    const rows = await fetchGlLineExportPage(companyId, opts, cursor, GL_LINE_EXPORT_MAX_PAGE);
    if (rows.length > 0) {
      res.write(rows.map((r) => csvLine(GL_LINE_EXPORT_COLUMNS, toExportRow(r, entity))).join('\n') + '\n');
      written += rows.length;
    }
    cursor = nextCursorOf(rows, GL_LINE_EXPORT_MAX_PAGE);
  } while (cursor !== null);

  if (written !== summary.rowCount) {
    // The header already promised summary.rowCount. A posting between the two
    // reads can move it; say so in the log rather than truncate silently.
    log.warn('GL lines export row count drifted during export', {
      companyId, promised: summary.rowCount, written,
    }, 'accounting-api');
  }
  res.end();
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
