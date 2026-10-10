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
 * X-Export-Timestamp, X-Schema-Version, X-Control-Total and
 * X-Unbalanced-Txn-Count. The row count is NOT a header — it is the manifest's
 * rowCount — because a header is sent before the first row and a posting
 * during the download can move it.
 *
 * STREAMED page by page (keyset), so full history never sits in memory at
 * once, and each write waits for the socket to drain when its buffer is full.
 * A failure once the first byte has gone out cannot become a 500 any more: it
 * is logged and the connection is destroyed, so the download fails visibly
 * instead of ending as a complete-looking but truncated file.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { hasNul, NUL_MESSAGE } from '@/lib/validation';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import {
  GL_LINE_EXPORT_COLUMNS,
  GL_LINE_EXPORT_SCHEMA_VERSION,
  csvLine,
  toExportRow,
} from '@/modules/accounting/services/reports/glLineExportRows';
import {
  GL_LINE_EXPORT_MAX_PAGE,
  fetchGlLineExportPage,
  getExportEntity,
  getGlLineExportSummary,
  nextCursorOf,
  type GlLineExportCursor,
  type GlLineExportOptions,
} from '@/modules/accounting/services/reports/glLineExportService';
import {
  GL_EXPORT_TABLES,
  getExportDimensionTablePage,
  isGlExportTable,
  type DimensionTablePage,
  type GlDimensionTable,
} from '@/modules/accounting/services/reports/glLineExportTables';

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Write, and when the socket's buffer is full wait for 'drain' — or fail if the client went away. */
function writeChunk(res: NextApiResponse, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (err?: Error) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => settle();
    const onClose = () => settle(new Error('client closed the connection during the export'));
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * Stream `header` then every chunk `next` yields (null ends it). An error
 * before the first byte propagates (withErrorHandler answers it); after it,
 * the connection is destroyed so the client sees a failed download.
 */
async function streamCsv(
  res: NextApiResponse, companyId: string, header: string, next: () => Promise<string | null>,
): Promise<void> {
  try {
    await writeChunk(res, header);
    for (let chunk = await next(); chunk !== null; chunk = await next()) {
      await writeChunk(res, chunk);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) throw err;
    log.error('GL lines export failed after the download started; connection destroyed', {
      companyId, error: err instanceof Error ? err.message : String(err),
    }, 'accounting-api');
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  }
}

function startCsv(res: NextApiResponse, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200);
}

async function streamTable(res: NextApiResponse, companyId: string, table: GlDimensionTable): Promise<void> {
  // The first page is read before any header goes out, so a failing read is
  // still a clean 500.
  let page: DimensionTablePage | null =
    await getExportDimensionTablePage(companyId, table, null, GL_LINE_EXPORT_MAX_PAGE);
  const columns = page.columns;
  startCsv(res, `gl-export-${table}.csv`);
  await streamCsv(res, companyId, columns.join(',') + '\n', async () => {
    if (page === null) return null;
    const chunk = page.rows.length === 0 ? '' : page.rows.map((r) => csvLine(columns, r)).join('\n') + '\n';
    page = page.next === null
      ? null
      : await getExportDimensionTablePage(companyId, table, page.next, GL_LINE_EXPORT_MAX_PAGE);
    return chunk;
  });
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

  // Ledger data with names and VAT numbers: never stored by a browser or proxy.
  res.setHeader('Cache-Control', 'no-store');
  const exportTimestamp = new Date().toISOString();
  res.setHeader('X-Export-Timestamp', exportTimestamp);
  res.setHeader('X-Schema-Version', GL_LINE_EXPORT_SCHEMA_VERSION);

  if (table !== 'lines') return streamTable(res, companyId, table);

  const opts: GlLineExportOptions = { dateFrom, dateTo, status };
  const summary = await getGlLineExportSummary(companyId, opts);
  if (one(req.query.manifest) === '1') {
    return apiResponse.success(res, { exportTimestamp, ...summary, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null, status });
  }

  const entity = await getExportEntity(companyId);
  res.setHeader('X-Control-Total', summary.controlTotal.toFixed(2));
  res.setHeader('X-Unbalanced-Txn-Count', String(summary.unbalancedTxnCount));
  startCsv(res, `gl-lines-${dateFrom ?? 'all'}-to-${dateTo ?? 'all'}.csv`);

  let cursor: GlLineExportCursor | null = null;
  let started = false;
  let written = 0;
  await streamCsv(res, companyId, GL_LINE_EXPORT_COLUMNS.join(',') + '\n', async () => {
    if (started && cursor === null) return null;
    started = true;
    const rows = await fetchGlLineExportPage(companyId, opts, cursor, GL_LINE_EXPORT_MAX_PAGE);
    cursor = nextCursorOf(rows, GL_LINE_EXPORT_MAX_PAGE);
    written += rows.length;
    return rows.length === 0 ? '' : rows.map((r) => csvLine(GL_LINE_EXPORT_COLUMNS, toExportRow(r, entity))).join('\n') + '\n';
  });

  if (res.writableEnded && written !== summary.rowCount) {
    // The manifest and the control headers came from the summary read. A
    // posting between it and the pages can move the count; say so in the log.
    log.warn('GL lines export row count drifted during export', {
      companyId, summaryRowCount: summary.rowCount, written,
    }, 'accounting-api');
  }
}

export default withAuth(withErrorHandler(handler));
