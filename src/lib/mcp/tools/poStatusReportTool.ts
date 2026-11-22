/**
 * MCP read tool: po_status_report (design docs/design/mcp-po-reports.md, section 5): per purchase order, what was ordered, received,
 * billed, is outstanding and is committed, its age, the days since its last receipt and bill, and the bills that tie it. Billed is
 * `get_purchase_order`'s billed_total and committed is the figure budget_remaining / committed_spend read: one engine, no recomputation
 * (`ap/poStatusReport`). Free; read:invoices, as get_purchase_order.
 */
import type { McpTool } from '../types';
import { PoReportScanError, readPoStatusReport } from '@/modules/accounting/services/ap/poStatusReport';
import { isRealCalendarDate } from '@/lib/validation';
import { PO_STATUSES } from './listPurchaseOrders';
import { OFFSET_SCHEMA, parseOffset } from './pageArgs';
import { PO_REPORT_LIMIT_DEFAULT, PO_REPORT_LIMIT_MAX, poStatusItem } from './poStatusReportView';
import { clampLimit, guardCastableArgs, ok, toolError } from './toolHelpers';

export const poStatusReportTool: McpTool = {
  name: 'po_status_report',
  description:
    'Purchase orders with where each stands, oldest first (then PO number): ordered (ex-VAT sum of its lines), received (per line min(received, ordered) quantity x unit price; a cancelled goods received note is already taken back), '
    + 'billed (get_purchase_order\'s billed_total: the one attribution, lines first, then the link, then the capped header fallback; approved / paid / partially_paid bills that are not deleted), outstanding (ordered less billed, floored at 0) and committed '
    + '(what budget_remaining / committed_spend count for it: 0 for a PO that does not commit), age_days, days_since_last_receipt and days_since_last_bill (null: none), status with closed_from_status and closed_by_billing, '
    + 'and the bills that tie it (up to 10: invoice_number, status, attributed_amount, invoice_date, attributed_via lines / link / header, counts_as_billed, deleted) with bills_total. Figures are decimal text, ex VAT. '
    + 'Filters: status (one or a list), supplier_id, from / to (order date), older_than_days (age_days above it), only_outstanding (outstanding above 0; narrow the filters first when more than 2000 POs match). '
    + `Paged: limit (default ${PO_REPORT_LIMIT_DEFAULT}, max ${PO_REPORT_LIMIT_MAX}), offset = the previous next_offset; total is over the whole filter. Needs read:invoices.`,
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        oneOf: [
          { type: 'string', enum: [...PO_STATUSES] },
          { type: 'array', items: { type: 'string', enum: [...PO_STATUSES] }, minItems: 1, maxItems: PO_STATUSES.length },
        ],
      },
      supplier_id: { type: 'string', format: 'uuid', description: 'Supplier UUID' },
      from: { type: 'string', format: 'date', description: 'Earliest order date, YYYY-MM-DD' },
      to: { type: 'string', format: 'date', description: 'Latest order date, YYYY-MM-DD' },
      older_than_days: { type: 'integer', minimum: 0, maximum: 36500, description: 'Only POs whose age_days is above this' },
      only_outstanding: { type: 'boolean', description: 'Only POs with something still to bill' },
      limit: { type: 'integer', minimum: 1, maximum: PO_REPORT_LIMIT_MAX },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const raw = args.status;
    const statuses = raw === undefined || raw === null ? null : Array.isArray(raw) ? raw : [raw];
    if (statuses && (statuses.length === 0 || statuses.some((s) => !(PO_STATUSES as readonly unknown[]).includes(s)))) {
      return toolError(`status must be one of (or a list of): ${PO_STATUSES.join(', ')}`);
    }
    for (const k of ['supplier_id', 'from', 'to'] as const) if (args[k] !== undefined && args[k] !== null && typeof args[k] !== 'string') return toolError(`invalid ${k}`);
    const bad = guardCastableArgs(args, { uuid: ['supplier_id'], date: ['from', 'to'] });
    if (bad) return bad;
    const older = args.older_than_days;
    if (older !== undefined && older !== null && (!Number.isInteger(older) || (older as number) < 0 || (older as number) > 36500)) {
      return toolError('older_than_days must be a whole number of days from 0 to 36500');
    }
    const only = args.only_outstanding;
    if (only !== undefined && only !== null && typeof only !== 'boolean') return toolError('only_outstanding must be true or false');
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const text = (k: string): string | null => (typeof args[k] === 'string' && (args[k] as string).trim() !== '' ? (args[k] as string).trim() : null);
    if (text('from') && !isRealCalendarDate(text('from')!)) return toolError('invalid from');
    try {
      const report = await readPoStatusReport(ctx.companyId, {
        statuses: statuses as string[] | null, supplierId: text('supplier_id')?.toLowerCase() ?? null, from: text('from'), to: text('to'),
        olderThanDays: typeof older === 'number' ? older : null, onlyOutstanding: only === true,
        offset, limit: clampLimit(args, PO_REPORT_LIMIT_DEFAULT, PO_REPORT_LIMIT_MAX),
      });
      return ok({ as_of: report.asOf, items: report.rows.map(poStatusItem), total: report.total, next_offset: report.nextOffset });
    } catch (err) {
      if (err instanceof PoReportScanError) return toolError(err.message);
      throw err;
    }
  },
};
