/**
 * GL Lines Export API — the flat ledger file for the finance model (ledger
 * brief §4 v1 fields, §9 export contract), plus the open-items and bank tables
 * a finance dashboard needs.
 *
 * GET
 *   ?table=lines|accounts|cost_centres|business_units|counterparties
 *         |ap_open_items|ar_open_items|bank_accounts   (default lines)
 *   ?date_from=YYYY-MM-DD  ?date_to=YYYY-MM-DD   (lines only; omitted = full history)
 *   ?status=all|posted                           (lines only; default all, labelled)
 *   — a computed table is as at today and REFUSES all three (400), so a caller
 *     expecting an as-at date never silently gets today's figures.
 *   ?manifest=1                                  (lines and the computed tables: JSON summary, no rows)
 *
 * AUTH: a browser session (cookie, as before) OR a Bearer token —
 * `Authorization: Bearer pat_…` (Personal Access Token) or `oat_…` — through
 * withBearerOrCookieAuth, which runs the shared Bearer pipeline: the token's
 * company becomes req.companyId, under the same app_user role, RLS claims and
 * per-company rate limit as withAuth. A token needs `read:reports` for every
 * table (withScope) and ALSO `read:contacts` for table=counterparties and
 * `read:bank-tx` for table=bank_accounts —
 * glLineExportTables.GL_EXPORT_EXTRA_SCOPE, the map the MCP tool
 * export_gl_lines reads too, so REST and MCP agree. A cookie session carries
 * no scopes and is not gated. GET only, so no CSRF wrapper (a Bearer caller
 * would get 403s from one).
 *
 * CSV, UTF-8, one file per table, header row, fixed column order. §9.2's file
 * facts travel as response headers so the CSV itself stays a pure table:
 * X-Export-Timestamp, X-Schema-Version, X-Control-Total and
 * X-Unbalanced-Txn-Count. The row count is NOT a header for lines — it is the
 * manifest's rowCount — because a header is sent before the first row and a
 * posting during the download can move it.
 *
 * COMPUTED TABLES (reports/glExportComputedTables: ap_open_items,
 * ar_open_items, bank_accounts) are built whole, as at today, before the first
 * byte, so their facts are exact and go out as headers
 * (glExportComputedTables.computedHeaders). Columns, headers and their
 * meaning: docs/api/gl-lines-export.md, reports/openItemsExport and
 * reports/bankAccountsExport.
 *
 * STREAMED page by page (keyset), so full history never sits in memory at
 * once, and each write waits for the socket to drain when its buffer is full.
 * The first page is read before the header row, so its failure is a 500. A
 * failure once the first byte has gone out cannot become a 500 any more: it
 * is logged and the connection is destroyed, so the download fails visibly
 * instead of ending as a complete-looking but truncated file. A client that
 * disconnects stops the export at the next write or page read.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withBearerOrCookieAuth, type BearerAuthedRequest } from '@/lib/auth/withBearerOrCookieAuth';
import { withScope } from '@/lib/auth/withScope';
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
  type GlLineExportOptions,
} from '@/modules/accounting/services/reports/glLineExportService';
import {
  GL_EXPORT_TABLES,
  getExportDimensionTablePage,
  isGlExportTable,
  missingExportScope,
  type DimensionTablePage,
  type GlDimensionTable,
} from '@/modules/accounting/services/reports/glLineExportTables';
import {
  buildComputedTable,
  computedHeaders,
  isGlComputedTable,
  type GlComputedTable,
} from '@/modules/accounting/services/reports/glExportComputedTables';

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The client went away (or the response already ended): stop quietly, nothing left to tell it. */
class ClientGoneError extends Error {
  constructor() {
    super('client closed the connection during the export');
  }
}

function gone(res: NextApiResponse): boolean {
  return res.destroyed || res.writableEnded;
}

/**
 * Write, and when the socket's buffer is full wait for 'drain' — or fail if
 * the client went away. 'close' may already have fired before this call (a
 * disconnect during a page query), so the state is checked, not only the
 * event: waiting for a 'close' that has passed hung the handler, and with it
 * withAuth's transaction and its pooled client (PR #688 round 2, REPRO A).
 */
function writeChunk(res: NextApiResponse, chunk: string): Promise<void> {
  if (gone(res)) return Promise.reject(new ClientGoneError());
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (err?: Error) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => settle();
    const onClose = () => settle(new ClientGoneError());
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * Stream `header`, then `first` and every page `after` reads (null ends it),
 * each rendered by `render`. The first page is read by the caller BEFORE any
 * header goes out, so a failing first read is still a clean 500. The client is
 * checked before every write and every page read; once it has gone the export
 * stops. A read failing after the first byte cannot become a 500 any more: it
 * is logged and the connection destroyed, so the client sees a failed download.
 */
async function streamPages<P>(
  res: NextApiResponse, companyId: string, header: string, first: P,
  render: (page: P) => string, after: (page: P) => Promise<P | null>,
): Promise<void> {
  try {
    await writeChunk(res, header);
    for (let page: P | null = first; page !== null;) {
      await writeChunk(res, render(page));
      if (gone(res)) throw new ClientGoneError();
      page = await after(page);
    }
    res.end();
  } catch (err) {
    if (err instanceof ClientGoneError) {
      log.warn('GL export stopped: the client closed the connection', { companyId }, 'accounting-api');
      return;
    }
    log.error('GL export failed after the download started; connection destroyed', {
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
  const first: DimensionTablePage = await getExportDimensionTablePage(companyId, table, null, GL_LINE_EXPORT_MAX_PAGE);
  const columns = first.columns;
  startCsv(res, `gl-export-${table}.csv`);
  await streamPages(res, companyId, columns.join(',') + '\n', first,
    (page) => (page.rows.length === 0 ? '' : page.rows.map((r) => csvLine(columns, r)).join('\n') + '\n'),
    async (page) => (page.next === null
      ? null
      : getExportDimensionTablePage(companyId, table, page.next, GL_LINE_EXPORT_MAX_PAGE)));
}

/** A computed table: built whole first (a failure is a clean 500), its exact facts as headers, then streamed in slices. */
async function streamComputed(
  res: NextApiResponse, companyId: string, table: GlComputedTable, manifest: boolean, exportTimestamp: string,
): Promise<void> {
  const built = await buildComputedTable(companyId, table);
  const { summary } = built;
  res.setHeader('X-Schema-Version', summary.schemaVersion);
  if (manifest) return apiResponse.success(res, { exportTimestamp, ...summary });
  for (const [name, value] of Object.entries(computedHeaders(summary))) res.setHeader(name, value);
  startCsv(res, `gl-export-${table}-${summary.asAt}.csv`);
  const columns = built.columns;
  const slice = (from: number) => built.rows.slice(from, from + GL_LINE_EXPORT_MAX_PAGE);
  let at = 0;
  await streamPages(res, companyId, columns.join(',') + '\n', slice(0),
    (rows) => (rows.length === 0 ? '' : rows.map((r) => csvLine(columns, r)).join('\n') + '\n'),
    async () => {
      at += GL_LINE_EXPORT_MAX_PAGE;
      return at < built.rows.length ? slice(at) : null;
    });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  if (hasNul(req.query)) return apiResponse.badRequest(res, NUL_MESSAGE);

  const { companyId, scopes } = req as BearerAuthedRequest;
  const table = one(req.query.table) ?? 'lines';
  if (!isGlExportTable(table)) {
    return apiResponse.badRequest(res, `table must be one of ${GL_EXPORT_TABLES.join(', ')}`);
  }
  // read:reports is withScope's; a table that needs more (counterparties:
  // read:contacts, bank_accounts: read:bank-tx) is refused here, before any
  // query, as the MCP tool does.
  const missing = missingExportScope(table, scopes);
  if (missing !== null) {
    return apiResponse.error(res, ErrorCode.INSUFFICIENT_SCOPE, `Token missing required scope for table "${table}": ${missing}`);
  }
  const dateFrom = one(req.query.date_from);
  const dateTo = one(req.query.date_to);
  if (isGlComputedTable(table) && (dateFrom !== undefined || dateTo !== undefined || one(req.query.status) !== undefined)) {
    return apiResponse.badRequest(res, `table "${table}" is as at today: date_from, date_to and status apply to table=lines only`);
  }
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

  if (isGlComputedTable(table)) {
    return streamComputed(res, companyId, table, one(req.query.manifest) === '1', exportTimestamp);
  }
  if (table !== 'lines') return streamTable(res, companyId, table);

  const opts: GlLineExportOptions = { dateFrom, dateTo, status };
  const summary = await getGlLineExportSummary(companyId, opts);
  if (one(req.query.manifest) === '1') {
    return apiResponse.success(res, { exportTimestamp, ...summary, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null, status });
  }

  const entity = await getExportEntity(companyId);
  const first = await fetchGlLineExportPage(companyId, opts, null, GL_LINE_EXPORT_MAX_PAGE);
  res.setHeader('X-Control-Total', summary.controlTotal.toFixed(2));
  res.setHeader('X-Unbalanced-Txn-Count', String(summary.unbalancedTxnCount));
  startCsv(res, `gl-lines-${dateFrom ?? 'all'}-to-${dateTo ?? 'all'}.csv`);

  let written = 0;
  await streamPages(res, companyId, GL_LINE_EXPORT_COLUMNS.join(',') + '\n', first,
    (rows) => {
      written += rows.length;
      return rows.length === 0 ? '' : rows.map((r) => csvLine(GL_LINE_EXPORT_COLUMNS, toExportRow(r, entity))).join('\n') + '\n';
    },
    async (rows) => {
      const cursor = nextCursorOf(rows, GL_LINE_EXPORT_MAX_PAGE);
      return cursor === null ? null : fetchGlLineExportPage(companyId, opts, cursor, GL_LINE_EXPORT_MAX_PAGE);
    });

  if (res.writableEnded && written !== summary.rowCount) {
    // The manifest and the control headers came from the summary read. A
    // posting between it and the pages can move the count; say so in the log.
    log.warn('GL lines export row count drifted during export', {
      companyId, summaryRowCount: summary.rowCount, written,
    }, 'accounting-api');
  }
}

// Bearer (PAT / OAuth) or cookie; a token needs read:reports. Composed as
// withScope's contract documents: the outer wrapper attaches the scopes.
export default withBearerOrCookieAuth(withScope('read:reports')(withErrorHandler(handler)));
