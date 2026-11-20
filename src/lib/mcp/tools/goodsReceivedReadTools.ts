/**
 * MCP read tools: list_goods_received and get_goods_received (design: docs/design/mcp-goods-received.md). Free. Cancelled notes
 * are listed with status cancelled. A goods received note never posts to the general ledger.
 */
import type { McpTool } from '../types';
import {
  GRN_DETAIL_CAPS, GRN_STATUSES, listGoodsReceived, readGoodsReceivedDetail,
} from '@/modules/accounting/services/ap/goodsReceivedReadService';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';
import { NOT_FOUND, clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export const listGoodsReceivedTool: McpTool = {
  name: 'list_goods_received',
  description:
    'Goods received notes of the connected company, ordered by received_date then grn_number: number, status (cancelled ones included, with who / when / why), '
    + 'received_date, received_by, the purchase order (po_number, its status), supplier, line_count, document_count (delivery notes filed on it, entity_type goods_received) '
    + 'and the external reference it was created with. Filter by po_id, supplier_id, date_from / date_to (received date), external_ref, status (one or a list). '
    + 'A goods received note posts nothing to the ledger. '
    + `Returns {goods_received_notes, total, next_offset}: up to limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); call again with offset=next_offset until it is null.`,
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID' },
      supplier_id: { type: 'string', description: 'Supplier UUID' },
      date_from: { type: 'string', format: 'date' },
      date_to: { type: 'string', format: 'date' },
      external_ref: { type: ['string', 'integer'], description: 'The source system id it was created with' },
      status: {
        oneOf: [
          { type: 'string', enum: [...GRN_STATUSES] },
          { type: 'array', items: { type: 'string', enum: [...GRN_STATUSES] }, minItems: 1, maxItems: GRN_STATUSES.length },
        ],
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['po_id', 'supplier_id'], date: ['date_from', 'date_to'] });
    if (bad) return bad;
    const raw = args.status;
    const statuses = raw === undefined || raw === null ? null : Array.isArray(raw) ? raw : [raw];
    if (statuses && (statuses.length === 0 || statuses.some((s) => !(GRN_STATUSES as readonly unknown[]).includes(s)))) {
      return toolError(`status must be one of (or a list of): ${GRN_STATUSES.join(', ')}`);
    }
    const rawRef = args.external_ref;
    const externalRef = typeof rawRef === 'number' && Number.isSafeInteger(rawRef) ? String(rawRef) : strArg(args, 'external_ref');
    if (rawRef !== undefined && rawRef !== null && externalRef === undefined) return toolError('external_ref must be a string or an integer');
    if (externalRef && externalRef.length > 128) return toolError('external_ref is longer than 128 characters');
    const dateFrom = strArg(args, 'date_from') ?? null;
    const dateTo = strArg(args, 'date_to') ?? null;
    if (dateFrom && dateTo && dateFrom > dateTo) return toolError('date_from must not be after date_to');
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const result = await listGoodsReceived(ctx.companyId, {
      poId: strArg(args, 'po_id') ?? null, supplierId: strArg(args, 'supplier_id') ?? null, dateFrom, dateTo,
      externalRef: externalRef ?? null, statuses: statuses as string[] | null,
    }, { limit: clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT), offset });
    return ok({ goods_received_notes: result.rows, total: result.total, next_offset: nextOffsetFromTotal(offset, result.rows.length, result.total) });
  },
};

export const getGoodsReceivedTool: McpTool = {
  name: 'get_goods_received',
  description:
    'One goods received note by grn_id: the note (status, received date / by, notes, purchase order and supplier, external reference, cancel details), '
    + 'its items (the PO line description, ordered quantity, this note\'s received and rejected quantities, and the PO line\'s total received), '
    + 'its documents (delivery notes filed on it) and the bills that carry it (supplier_invoices.grn_id; a deleted bill is listed with deleted: true). '
    + 'An item whose PO line is not on the note\'s purchase order (an old record) is listed with on_purchase_order: false and the line\'s description and quantities null. '
    + `Items page: items_limit (default and max ${GRN_DETAIL_CAPS.items}) from items_offset; the reply carries items_total, items_truncated (true when this page is not every item) and items_next_offset (null on the last page). `
    + `Documents (both the goods_received and the legacy goods_receipt_note entity types) are capped at ${GRN_DETAIL_CAPS.documents} and bills at ${GRN_DETAIL_CAPS.bills}, with documents_total / bills_total beside them; long text is cut at 150 characters, notes and the cancel reason at 500. `
    + 'A goods received note posts nothing to the ledger.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      grn_id: { type: 'string', description: 'Goods received note UUID (list_goods_received)' },
      items_offset: { ...OFFSET_SCHEMA, description: 'Items to skip. Pass the previous reply\'s items_next_offset; omit for the first page.' },
      items_limit: { type: 'integer', minimum: 1, maximum: GRN_DETAIL_CAPS.items, description: `Items per page (default and max ${GRN_DETAIL_CAPS.items})` },
    },
    required: ['grn_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!strArg(args, 'grn_id')) return toolError('grn_id is required');
    const bad = guardCastableArgs(args, { uuid: ['grn_id'] });
    if (bad) return bad;
    const itemsOffset = parseOffset({ offset: args.items_offset });
    if (typeof itemsOffset === 'string') return toolError(`items_${itemsOffset}`);
    const rawLimit = args.items_limit;
    if (rawLimit !== undefined && rawLimit !== null
      && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > GRN_DETAIL_CAPS.items)) {
      return toolError(`items_limit must be an integer from 1 to ${GRN_DETAIL_CAPS.items}`);
    }
    const itemsLimit = typeof rawLimit === 'number' ? rawLimit : GRN_DETAIL_CAPS.items;
    const detail = await readGoodsReceivedDetail(ctx.companyId, strArg(args, 'grn_id')!, { offset: itemsOffset, limit: itemsLimit });
    return detail ? ok(detail) : toolError(NOT_FOUND);
  },
};
