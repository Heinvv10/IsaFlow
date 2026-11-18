/**
 * MCP read tool: list_purchase_orders — the company's purchase orders with number, supplier, status, totals, whether
 * a document (the source PDF) is filed on each, and the external reference an import stamped. Offset-paged on
 * (po_number, id); totals over the whole filter.
 */
import type { McpTool } from '../types';
import { listPurchaseOrdersForMcp } from '@/modules/accounting/services/ap/purchaseOrderListService';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const PO_STATUSES = ['draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled'] as const;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export const listPurchaseOrdersTool: McpTool = {
  name: 'list_purchase_orders',
  description:
    'Purchase orders of the connected company, ordered by po_number: number, supplier, status, order and delivery dates, '
    + 'subtotal / tax_amount / total, line_count, has_document (a PDF or other file is filed on it, entity_type purchase_order) '
    + 'and the external reference an import stamped. Filter by po_number (exact), status (one or a list), supplier_id, '
    + 'from_date / to_date (order date), external_system + external_ref. '
    + 'Committed spend counts approved, partially_received and received POs only; closed (billed in full) and cancelled commit nothing. '
    + `Returns {purchase_orders, total, totals, next_offset}: up to limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); `
    + 'call again with offset=next_offset until it is null.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      po_number: { type: 'string', maxLength: 50 },
      status: {
        oneOf: [
          { type: 'string', enum: [...PO_STATUSES] },
          { type: 'array', items: { type: 'string', enum: [...PO_STATUSES] }, minItems: 1, maxItems: PO_STATUSES.length },
        ],
      },
      supplier_id: { type: 'string', description: 'Supplier UUID' },
      from_date: { type: 'string', format: 'date' },
      to_date: { type: 'string', format: 'date' },
      external_system: { type: 'string', maxLength: 32 },
      external_ref: { type: ['string', 'integer'], description: 'The source system id, e.g. a Sage PO id' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['supplier_id'], date: ['from_date', 'to_date'] });
    if (bad) return bad;
    const rawStatus = args.status;
    const statuses = rawStatus === undefined || rawStatus === null ? null : Array.isArray(rawStatus) ? rawStatus : [rawStatus];
    if (statuses && (statuses.length === 0 || statuses.some((s) => !(PO_STATUSES as readonly unknown[]).includes(s)))) {
      return toolError(`status must be one of (or a list of): ${PO_STATUSES.join(', ')}`);
    }
    const poNumber = strArg(args, 'po_number');
    if (poNumber && poNumber.length > 50) return toolError('po_number is longer than 50 characters');
    const externalSystem = strArg(args, 'external_system');
    if (externalSystem && externalSystem.length > 32) return toolError('external_system is longer than 32 characters');
    const rawRef = args.external_ref;
    const externalRef = typeof rawRef === 'number' && Number.isSafeInteger(rawRef) ? String(rawRef) : strArg(args, 'external_ref');
    if (rawRef !== undefined && rawRef !== null && externalRef === undefined) return toolError('external_ref must be a string or an integer');
    if (externalRef && externalRef.length > 128) return toolError('external_ref is longer than 128 characters');
    const fromDate = strArg(args, 'from_date') ?? null;
    const toDate = strArg(args, 'to_date') ?? null;
    if (fromDate && toDate && fromDate > toDate) return toolError('from_date must not be after to_date');
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);

    const result = await listPurchaseOrdersForMcp(ctx.companyId, {
      poNumber: poNumber ?? null, statuses: statuses as string[] | null, supplierId: strArg(args, 'supplier_id') ?? null,
      fromDate, toDate, externalSystem: externalSystem ?? null, externalRef: externalRef ?? null,
    }, { limit: clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT), offset });

    return ok({
      purchase_orders: result.rows.map((r) => ({
        id: r.id, po_number: r.poNumber, supplier_id: r.supplierId, supplier_name: r.supplierName,
        order_date: r.orderDate, delivery_date: r.deliveryDate, status: r.status, reference: r.reference,
        subtotal: r.subtotal, tax_amount: r.taxAmount, total: r.total, line_count: r.lineCount,
        has_document: r.documentCount > 0, document_count: r.documentCount,
        external_system: r.externalSystem, external_ref: r.externalRef, external_document_number: r.externalDocumentNumber,
      })),
      total: result.total,
      totals: { subtotal: result.totals.subtotal, tax_amount: result.totals.taxAmount, total: result.totals.total },
      next_offset: nextOffsetFromTotal(offset, result.rows.length, result.total),
    });
  },
};
