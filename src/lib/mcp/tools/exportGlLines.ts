/**
 * `export_gl_lines` — the flat GL-line export (ledger brief §4 v1 / §9) over
 * MCP: the same rows, columns and summary as /api/accounting/gl-lines-export,
 * paged with a keyset cursor.
 *
 * The summary (row count, control total, unbalanced transactions) is present at
 * every detail level, because it is what a reader checks before using a single
 * row: rowCount is the number of rows paging to exhaustion yields, and the
 * control total must be zero on a balanced ledger.
 *
 * Rows come back as arrays under one `columns` header — 51 columns keyed per
 * row would more than double the payload for no information.
 */
import type { McpTool } from '../types';
import {
  GL_EXPORT_TABLES,
  GL_LINE_EXPORT_COLUMNS,
  GL_LINE_EXPORT_SCHEMA_VERSION,
  fetchGlLineExportPage,
  getExportDimensionTable,
  getExportEntityName,
  getGlLineExportSummary,
  isGlExportTable,
  nextCursorOf,
  toExportRow,
  type GlLineExportCursor,
  type GlLineExportStatus,
} from '@/modules/accounting/services/reports/glLineExportService';
import { getLedgerPostedThrough } from '@/modules/accounting/services/reports/postedThroughService';
import { buildEnvelope, decodeCursor, encodeCursor, isDetailLevel, type DetailLevel } from '@/lib/mcp/contracts';
import { UUID_RE } from '@/lib/validation';
import { isLedgerDate } from '@/modules/accounting/services/gl/ledgerDateRange';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const DESCRIPTION = [
  'The flat general-ledger export for the finance model: ONE ROW PER JOURNAL LINE, every account (both sides of every transaction), in the fixed column order of the ledger brief §4 v1 contract (schema ' + GL_LINE_EXPORT_SCHEMA_VERSION + ').',
  'Columns include Line_ID, Txn_ID, Journal_Type, Document_No, Txn_Date, Period, FY (March–February, named by the year it ends: Mar-2025 = FY26 period 1), signed Amount_Excl_VAT (debit positive, credit negative), VAT_Code, the GL account and its reporting ladder (class, category, statement line/group, cash class, capex/opex), CC1/CC2/BU codes and names with the CC2 parent, counterparty, bank account on cash lines, Payment_Ref, Posting_Status and Period_Locked.',
  'VAT is its own row on the VAT control account, so VAT_Amount is 0.00 on every row and Amount_Incl_VAT = Amount_Excl_VAT in v1; every posted Txn_ID sums to zero.',
  'summary (always present) is the §9 control block: rowCount = rows paging to exhaustion yields, controlTotal = Σ Amount_Excl_VAT over Posted rows (must be 0.00), unbalancedTxnCount (must be 0). detail "summary" returns only that. Page with next_cursor. Omit dates for full history. status "all" (default) includes Draft and Reversed journals, labelled; "posted" exports only what feeds the statements.',
  'table: "accounts" | "cost_centres" | "business_units" | "counterparties" returns that dimension master instead (all rows, no paging) — every code a line carries resolves to a row there. The same files download as CSV from /api/accounting/gl-lines-export.',
].join(' ');

export const exportGlLinesTool: McpTool = {
  name: 'export_gl_lines',
  description: DESCRIPTION,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: [...GL_EXPORT_TABLES], description: 'Default lines.' },
      date_from: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD. Omit for full history.' },
      date_to: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      status: { type: 'string', enum: ['all', 'posted'], description: 'Default all.' },
      limit: { type: 'number', description: `Rows per page, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['date_from', 'date_to'] });
    if (guard) return guard;
    const table = strArg(args, 'table') ?? 'lines';
    if (!isGlExportTable(table)) return toolError(`table must be one of ${GL_EXPORT_TABLES.join(', ')}`);

    if (table !== 'lines') {
      const dim = await getExportDimensionTable(ctx.companyId, table);
      return ok({
        table,
        schema_version: GL_LINE_EXPORT_SCHEMA_VERSION,
        row_count: dim.rows.length,
        columns: dim.columns,
        rows: dim.rows.map((r) => dim.columns.map((c) => r[c] ?? null)),
      });
    }

    const dateFrom = strArg(args, 'date_from');
    const dateTo = strArg(args, 'date_to');
    if (dateFrom !== undefined && dateTo !== undefined && dateTo < dateFrom) {
      return toolError('date_to must not precede date_from');
    }
    const rawStatus = strArg(args, 'status') ?? 'all';
    if (rawStatus !== 'all' && rawStatus !== 'posted') return toolError('status must be all or posted');
    const status: GlLineExportStatus = rawStatus;
    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';
    const limit = clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT);

    let cursor: GlLineExportCursor | null = null;
    const rawCursor = strArg(args, 'cursor');
    if (rawCursor !== undefined) {
      const key = decodeCursor(rawCursor, 3);
      const [d, e, l] = key?.parts ?? [];
      if (!key || !isLedgerDate(d) || !UUID_RE.test(e ?? '') || !UUID_RE.test(l ?? '')) {
        return toolError('invalid cursor');
      }
      cursor = { entryDate: d!, entryId: e!, lineId: l! };
    }

    const opts = { dateFrom, dateTo, status };
    // SEQUENTIAL: one pg client per request transaction (see profit_and_loss).
    const summary = await getGlLineExportSummary(ctx.companyId, opts);
    const asAt = dateTo ?? summary.lastTxnDate ?? new Date().toISOString().slice(0, 10);
    const postedThrough = await getLedgerPostedThrough(ctx.companyId, asAt, dateFrom);

    let rows: Array<Array<string | number | boolean | null>> = [];
    let next: GlLineExportCursor | null = null;
    if (detail !== 'summary') {
      const entity = await getExportEntityName(ctx.companyId);
      const page = await fetchGlLineExportPage(ctx.companyId, opts, cursor, limit);
      rows = page.map((r) => {
        const row = toExportRow(r, entity);
        return GL_LINE_EXPORT_COLUMNS.map((c) => row[c]);
      });
      next = nextCursorOf(page, limit);
    }

    const envelope = buildEnvelope({
      rows,
      // The window's line count, from the summary query that shares the page
      // query's predicate — a page is a slice of it, so `truncated` means
      // "more pages", and next_cursor says where.
      rowsTotal: summary.rowCount,
      detail,
      as_at: asAt,
      posted_through: postedThrough,
      next_cursor: next === null ? null : encodeCursor({ parts: [next.entryDate, next.entryId, next.lineId] }),
    });

    return ok({
      ...envelope,
      table,
      date_from: dateFrom ?? null,
      date_to: dateTo ?? null,
      status,
      columns: GL_LINE_EXPORT_COLUMNS,
      summary,
    });
  },
};
