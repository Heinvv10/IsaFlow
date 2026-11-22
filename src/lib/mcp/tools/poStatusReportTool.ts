/**
 * MCP read tool: po_status_report (design docs/design/mcp-po-reports.md, section 5): per purchase order, what was ordered, received,
 * billed, is outstanding and is committed, its age, the days since its last receipt and bill, and the bills that tie it. Billed is
 * `get_purchase_order`'s billed_total and committed is the figure budget_remaining / committed_spend read: one engine, no recomputation
 * (`ap/poStatusReport`). Free; read:invoices, as get_purchase_order.
 */
import { canWrite } from '@/lib/auth/writeRoles';
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
    'Purchase orders with where each stands, oldest first (then PO number): ordered (the PO\'s billing basis: the larger of its header subtotal and its lines, ex VAT), received (per line the line total x min(received, ordered) / ordered quantity, so a fully received line is its line total; a cancelled goods received note is already taken back), '
    + 'billed (get_purchase_order\'s billed_total: the one attribution, lines first, then the link, then the capped header fallback; approved / paid / partially_paid bills that are not deleted), outstanding (ordered less billed, floored at 0) and committed '
    + '(the PO\'s open committed value from the engine budget_remaining reads, 0 for a PO that does not commit; it counts lines with no account, which committed_spend reports under no_account and budget_remaining never sees; '
    + 'shown to owners, admins and managers only: null with committed_hidden for any other role, the rest of the report whole), age_days, days_since_last_receipt (from the latest note that holds goods: not a draft, rejected or cancelled one) and days_since_last_bill (null: none), status with closed_from_status and closed_by_billing, '
    + 'and the bills that tie it (the 10 newest: invoice_number, status, attributed_amount, invoice_date, attributed_via lines / link / header, counts_as_billed: false for a bill not yet approved; a soft-deleted or cancelled bill is never listed) with bills_total. Figures are decimal text, ex VAT. '
    + 'Filters: status (one or a list), supplier_id, from / to (order date), older_than_days (age_days above it), only_outstanding (still to bill on a live order: approved, partially_received or received POs with outstanding above 0; closed, cancelled and draft POs are left out, though their outstanding field still reads as above; narrow the filters first when more than 2000 POs match). '
    + `as_of is the day the ages are measured to (Johannesburg). Paged: limit (default ${PO_REPORT_LIMIT_DEFAULT}, max ${PO_REPORT_LIMIT_MAX}), offset = the previous next_offset; total is over the whole filter. Needs read:invoices.`,
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
        olderThanDays: typeof older === 'number' ? older : null, onlyOutstanding: only === true, includeCommitted: canWrite(ctx.companyRole),
        offset, limit: clampLimit(args, PO_REPORT_LIMIT_DEFAULT, PO_REPORT_LIMIT_MAX),
      });
      return ok({ as_of: report.asOf, items: report.rows.map(poStatusItem), total: report.total, next_offset: report.nextOffset });
    } catch (err) {
      if (err instanceof PoReportScanError) return toolError(err.message);
      throw err;
    }
  },
};
