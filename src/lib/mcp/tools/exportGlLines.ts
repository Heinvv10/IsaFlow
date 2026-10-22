/**
 * `export_gl_lines` — the flat GL-line export (ledger brief §4 v1 / §9) over
 * MCP: the same rows, columns and summary as /api/accounting/gl-lines-export,
 * paged with a keyset cursor.
 *
 * The summary (row count, control total, unbalanced transactions) comes with
 * the FIRST page only — the call without a cursor — because it aggregates the
 * whole window and recomputing it per 100-row page multiplied that cost by the
 * page count. The window's row count travels inside the cursor, so every later
 * page still reports rowsTotal.
 *
 * Rows come back as arrays under one `columns` header — 52 columns keyed per
 * row would more than double the payload for no information.
 *
 * The computed tables (ap_open_items, ar_open_items, bank_accounts —
 * reports/glExportComputedTables) are built whole on every call, so their
 * summary (the control block: Σ Outstanding against the aged report's net
 * total) describes the complete table; it comes with the first page only, as
 * the lines' does. Their cursor is [kind, id] over the built rows' order.
 *
 * Scopes: read:reports (the tool's own) for every table, plus whatever
 * glLineExportTables.GL_EXPORT_EXTRA_SCOPE names — counterparties needs
 * read:contacts. The REST route reads the same map.
 */
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { GL_LINE_EXPORT_COLUMNS, GL_LINE_EXPORT_SCHEMA_VERSION, toExportRow } from '@/modules/accounting/services/reports/glLineExportRows';
import {
  fetchGlLineExportPage,
  getExportEntity,
  getGlLineExportSummary,
  nextCursorOf,
  type GlLineExportCursor,
  type GlLineExportStatus,
} from '@/modules/accounting/services/reports/glLineExportService';
import {
  GL_EXPORT_TABLES,
  GL_TABLE_CURSOR_KINDS,
  countExportDimensionTable,
  getExportDimensionTablePage,
  isGlDimensionTable,
  isGlExportTable,
  missingExportScope,
  type GlDimensionTable,
} from '@/modules/accounting/services/reports/glLineExportTables';
import {
  GL_COMPUTED_CURSOR_KINDS,
  buildComputedTable,
  isGlComputedTable,
  pageComputedTable,
  type GlComputedTable,
} from '@/modules/accounting/services/reports/glExportComputedTables';
import { getLedgerPostedThrough } from '@/modules/accounting/services/reports/postedThroughService';
import { buildEnvelope, decodeCursor, encodeCursor, isDetailLevel, type DetailLevel } from '@/lib/mcp/contracts';
import { insufficientScopeMessage } from '@/lib/mcp/scopeRemediation';
import { UUID_RE } from '@/lib/validation';
import { isLedgerDate } from '@/modules/accounting/services/gl/ledgerDateRange';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * A table whose extra scope (GL_EXPORT_EXTRA_SCOPE) the token lacks —
 * `table=counterparties` without read:contacts. That table carries customer
 * and supplier names and VAT numbers — what list_customers / list_suppliers
 * serve only under read:contacts — so read:reports alone must not widen to
 * it. Raised before any query.
 */
export class GlExportScopeRefusal extends Error {
  readonly code = 'GL_EXPORT_SCOPE_REFUSED';
  constructor(table: string, scope: string) {
    const what = table === 'counterparties' ? ' lists customer and supplier names and VAT numbers.' : ' needs another scope.';
    super(`table "${table}"${what} ${insufficientScopeMessage(scope)}`);
    this.name = 'GlExportScopeRefusal';
  }
}

const DESCRIPTION = [
  'The flat general-ledger export for the finance model: ONE ROW PER JOURNAL LINE, every account (both sides of every transaction), in the fixed column order of the ledger brief §4 v1 contract (schema ' + GL_LINE_EXPORT_SCHEMA_VERSION + ').',
  'Columns include Line_ID, Txn_ID, Journal_Type, Document_No (with Linked_Document_Count — above 1, the journal has several documents and Document_No/counterparty show the first), Txn_Date, Period, FY and FY_Period_No on the company\'s own financial year (named by the year it ends: on a March year Mar-2025 = FY26 period 1), signed Amount_Excl_VAT (debit positive, credit negative), VAT_Code, the GL account and its reporting ladder (class, category, statement line/group, cash class, capex/opex), CC1/CC2/BU codes and names with the CC2 parent, counterparty, bank account on cash lines, Payment_Ref, Posting_Status and Period_Locked.',
  'VAT is its own row on the VAT control account, so VAT_Amount is 0.00 on every row and Amount_Incl_VAT = Amount_Excl_VAT in v1; every posted Txn_ID sums to zero.',
  'summary is the §9 control block — rowCount = rows paging to exhaustion yields, controlTotal = Σ Amount_Excl_VAT over Posted rows (must be 0.00), unbalancedTxnCount (must be 0) — and comes with the FIRST page only (no cursor); later pages return summary null and carry rowsTotal from the first. detail "summary" returns only that. Page with next_cursor, sending the same date_from, date_to and status (a cursor is refused with any other). Omit dates for full history. status "all" (default) includes Draft and Reversed journals, labelled; "posted" exports only what feeds the statements.',
  'table: "accounts" | "cost_centres" | "business_units" | "counterparties" returns that dimension master instead, paged the same way (limit, next_cursor; row_count on every page) — every code a line carries resolves to a row there. "counterparties" (names and VAT numbers) also needs the read:contacts scope.',
  'table "ap_open_items" / "ar_open_items": one row per open bill / customer invoice as at today (Doc_Type invoice) plus the unconsumed credit notes (credit_note) and on-account cash (unapplied_payment / unapplied_receipt) as NEGATIVE rows, with Days_Overdue, Age_Bucket (current|30|60|90|120+, the aging\'s own bucketing), Outstanding, Disputed, CC1/CC2/BU codes (MIXED when the lines differ) and Has_Document; the first page\'s summary carries controlTotal (Σ Outstanding), agedTotal (the aged_creditors / aged_debtors net total, computed through that report\'s own functions) and difference (must be 0.00), plus grossTotal, unappliedTotal and the gross buckets. table "bank_accounts": one row per bank / card account with Ledger_Balance (GL, as at today; blank for an account cash.balance does not hold), last statement date and closing balance, last completed reconciliation, unreconciled and unallocated line counts, last transaction date, Is_Active.',
  'The same files download as CSV from /api/accounting/gl-lines-export, with a browser session or a Personal Access Token holding the same scopes.',
].join(' ');

/** A count carried in a cursor: digits only, so a forged one cannot reach a query. */
const isCount = (v: string | undefined): v is string => v !== undefined && /^\d{1,12}$/.test(v);

async function computedPage(
  table: GlComputedTable, args: Record<string, unknown>, ctx: McpToolContext,
): Promise<McpToolResult> {
  const limit = clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT);
  const rawCursor = strArg(args, 'cursor');
  let cursor: readonly [string, string] | null = null;
  if (rawCursor !== undefined) {
    const [kind, id] = decodeCursor(rawCursor, 2)?.parts ?? [];
    if (kind === undefined || !GL_COMPUTED_CURSOR_KINDS.includes(kind) || !UUID_RE.test(id ?? '')) {
      return toolError('invalid cursor');
    }
    cursor = [kind, id!];
  }
  const built = await buildComputedTable(ctx.companyId, table);
  const page = pageComputedTable(table, built, cursor, limit);
  return ok({
    table,
    schema_version: built.summary.schemaVersion,
    as_at: built.summary.asAt,
    row_count: built.rows.length,
    columns: page.columns,
    rows: page.rows.map((r) => page.columns.map((c) => r[c] ?? null)),
    next_cursor: page.next === null ? null : encodeCursor({ parts: [...page.next] }),
    // The control block, first page only — a later page is a slice of a table
    // rebuilt for it, and its summary would describe a table already paged.
    summary: cursor === null ? built.summary : null,
  });
}

async function tablePage(
  table: GlDimensionTable, args: Record<string, unknown>, ctx: McpToolContext,
): Promise<McpToolResult> {
  const limit = clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT);
  const rawCursor = strArg(args, 'cursor');
  let cursor: readonly [string, string] | null = null;
  let total: number;
  if (rawCursor !== undefined) {
    const [n, kind, id] = decodeCursor(rawCursor, 3)?.parts ?? [];
    if (!isCount(n) || kind === undefined || !GL_TABLE_CURSOR_KINDS.includes(kind) || !UUID_RE.test(id ?? '')) {
      return toolError('invalid cursor');
    }
    cursor = [kind, id!];
    total = Number(n);
  } else {
    total = await countExportDimensionTable(ctx.companyId, table);
  }
  const page = await getExportDimensionTablePage(ctx.companyId, table, cursor, limit);
  return ok({
    table,
    schema_version: GL_LINE_EXPORT_SCHEMA_VERSION,
    row_count: total,
    columns: page.columns,
    rows: page.rows.map((r) => page.columns.map((c) => r[c] ?? null)),
    next_cursor: page.next === null ? null : encodeCursor({ parts: [String(total), ...page.next] }),
  });
}

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
    const missing = missingExportScope(table, ctx.scopes);
    if (missing !== null) throw new GlExportScopeRefusal(table, missing);
    if (isGlComputedTable(table)) return computedPage(table, args, ctx);
    if (isGlDimensionTable(table)) return tablePage(table, args, ctx);

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

    // Cursor parts: the first page's rowCount and as_at, the window it was
    // issued for, then the keyset (date, entry id, line id) — the last part is
    // the unique row id. The window is BOUND: rowCount and the keyset belong to
    // it, so a cursor sent with another date_from / date_to / status is refused
    // (it reported the first window's count as the second's).
    const windowKey = `${dateFrom ?? ''}~${dateTo ?? ''}~${status}`;
    let cursor: GlLineExportCursor | null = null;
    let carried: { rowCount: number; asAt: string } | null = null;
    const rawCursor = strArg(args, 'cursor');
    if (rawCursor !== undefined) {
      const [n, asAt, w, d, e, l] = decodeCursor(rawCursor, 6)?.parts ?? [];
      if (!isCount(n) || !isLedgerDate(asAt) || !isLedgerDate(d) || !UUID_RE.test(e ?? '') || !UUID_RE.test(l ?? '')) {
        return toolError('invalid cursor');
      }
      if (w !== windowKey) {
        return toolError('cursor belongs to another date_from / date_to / status: send the same three as the first page, or start again without a cursor');
      }
      cursor = { entryDate: d!, entryId: e!, lineId: l! };
      carried = { rowCount: Number(n), asAt: asAt! };
    }

    const opts = { dateFrom, dateTo, status };
    // SEQUENTIAL: one pg client per request transaction (see profit_and_loss).
    const summary = carried === null ? await getGlLineExportSummary(ctx.companyId, opts) : null;
    const rowsTotal = carried?.rowCount ?? summary!.rowCount;
    const asAt = carried?.asAt ?? dateTo ?? summary!.lastTxnDate ?? new Date().toISOString().slice(0, 10);
    const postedThrough = await getLedgerPostedThrough(ctx.companyId, asAt, dateFrom);

    let rows: Array<Array<string | number | boolean | null>> = [];
    let next: GlLineExportCursor | null = null;
    if (detail !== 'summary') {
      const entity = await getExportEntity(ctx.companyId);
      const page = await fetchGlLineExportPage(ctx.companyId, opts, cursor, limit);
      rows = page.map((r) => {
        const row = toExportRow(r, entity);
        return GL_LINE_EXPORT_COLUMNS.map((c) => row[c]);
      });
      next = nextCursorOf(page, limit);
    }

    const envelope = buildEnvelope({
      rows,
      // The window's line count, from the first page's summary query, which
      // shares the page query's predicate — a page is a slice of it, so
      // `truncated` means "more pages", and next_cursor says where.
      rowsTotal,
      detail,
      as_at: asAt,
      posted_through: postedThrough,
      next_cursor: next === null
        ? null
        : encodeCursor({ parts: [String(rowsTotal), asAt, windowKey, next.entryDate, next.entryId, next.lineId] }),
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
