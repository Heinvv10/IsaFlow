/**
 * MCP read tools: item master, stock valuation, and the supplier statement.
 *
 * `stock_valuation` has to be read with its own description in hand. Three
 * parallel inventory models live in this schema and only one holds data:
 * `items` and `stock_items` are both empty, while `products` and
 * `stock_movements` carry every real row. A valuation built on either empty
 * model would confidently return zero, so this one reads the model that is
 * actually used and says which.
 *
 * `supplier_statement` is the deliberate mirror of `customer_statement`,
 * including the credit-note status rule that had hidden every applied customer
 * credit note from every statement ever sent.
 */
import type { McpTool } from '../types';
import { listItems } from '@/modules/accounting/services/items/itemService';
import { getStockValuation } from '@/modules/accounting/services/items/stockValuationService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import { buildEnvelope, figureBasis, isDetailLevel } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import { guardCastableArgs, NOT_FOUND, ok, strArg, toolError } from './toolHelpers';
import { fmtDate } from '@/lib/fmtDate';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

const ITEM_TYPES = ['physical', 'service'] as const;
const ACTIVE_VALUES = ['true', 'false'] as const;

/**
 * Narrow an agent-supplied string to a literal union, or drop it.
 *
 * `additionalProperties: false` and a JSON Schema `enum` are advisory here —
 * nothing in this server validates against the schema — so an out-of-range
 * value must not reach a service that types the argument as a union.
 */
function enumArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = strArg(args, key);
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

export const listItemsTool: McpTool = {
  name: 'list_items',
  description:
    'List the item master — the products and services that can go on an invoice, quote or purchase order: code, description, type, unit, cost price and selling price. ' +
    'This is the `items` catalogue, which is SEPARATE from the `products` table that stock movements are recorded against. It is empty on every company in these books, so an empty result means nothing has been catalogued rather than that the search matched nothing. Use stock_valuation for what is physically on hand. ' +
    'It lists both active and inactive items by default; pass active to narrow. Soft-deleted items never appear. Prices are the catalogue defaults, not what any particular document was actually billed at. Results are capped at 500 rows and there is no cursor — narrow with q or category_id if you hit the cap.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Matches item code or description.' },
      type: { type: 'string', enum: ['physical', 'service'] },
      active: { type: 'string', enum: ['true', 'false'] },
      category_id: { type: 'string', description: 'Item category UUID.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['category_id'] });
    if (guard) return guard;

    const detail = detailOf(args);
    const items = await listItems(ctx.companyId, {
      q: strArg(args, 'q'),
      type: enumArg(args, 'type', ITEM_TYPES),
      active: enumArg(args, 'active', ACTIVE_VALUES),
      category_id: strArg(args, 'category_id'),
    });

    const rows = items.map((i) => ({
      id: String(i.id),
      code: String(i.code ?? ''),
      description: String(i.description ?? ''),
      item_type: String(i.item_type ?? ''),
      unit: i.unit == null ? null : String(i.unit),
      category_name: i.category_name == null ? null : String(i.category_name),
      cost_price: Number(i.cost_price) || 0,
      selling_price: Number(i.selling_price) || 0,
      is_active: i.is_active !== false,
    }));

    return ok(buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      // universeTotal omitted deliberately. These rows ARE the population —
      // nothing is filtered out of a wider candidate set and excludedRows is
      // always empty, so `rowsTotal + 0 === rowsTotal` could not fail whatever
      // the query did. An absent claim is honest; one that cannot fail reads
      // as a passed verification. CONTRACTS.md §1.
      detail,
      as_at: fmtDate(new Date()),
      // The item master is a catalogue, not a ledger — there is nothing honest
      // to pin it to, and now() would prove nothing.
      posted_through: NO_LEDGER_ROWS,
      excludedRows: [],
    }));
  },
};

export const stockValuationTool: McpTool = {
  name: 'stock_valuation',
  description:
    'Quantity on hand and value per product as at a date, derived from stock movements: inbound movements add, everything else subtracts, and value is the cost recorded ON each movement. ' +
    'READ THIS BEFORE TRUSTING THE TOTAL. Every stock movement in these books is a purchase carrying total_cost 0.00, so stock has been received and never valued — the report returns a real quantity against a zero value and flags each such product with unvalued: true rather than presenting R0 as a valuation somebody computed. ' +
    'It reads the products/stock_movements model, which is the one that holds data. The items and stock_items catalogues are separate and empty; list_items shows the first of those. ' +
    'stock_movements and stock_levels have NO company_id column of their own, so this report is tenant-scoped by joining products. Movements whose product carries no company_id belong to no tenant and are NOT attributed to you. Their EXISTENCE is disclosed in excludedRows as product_has_no_company; their number and value are withheld on purpose, because that query cannot be scoped to you and any figure it returned would be computed from rows that may belong to other tenants. Stocktake movements record an absolute quantity rather than a change and are excluded from quantity on hand as stocktake_count_not_a_delta. universeTotal counts YOUR products; neither disclosure inflates it. ' +
    'It is not a stock ledger and does not show individual movements, does not apply FIFO, weighted-average or any other costing method beyond the cost written on each movement, and is not reconciled to any GL inventory account.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['as_at'] });
    if (guard) return guard;

    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    const detail = detailOf(args);
    const v = await getStockValuation(ctx.companyId, asAt);

    const rows = v.rows.map((r) => ({
      product_id: r.productId,
      code: r.code,
      name: r.name,
      unit: r.unit,
      quantity_on_hand: r.quantityOnHand,
      value: r.value,
      average_cost: r.averageCost,
      movement_count: r.movementCount,
      unvalued: r.unvalued,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: v.rowsTotal,
      universeTotal: v.universeTotal,
      detail,
      as_at: asAt,
      posted_through: v.postedThrough ?? NO_LEDGER_ROWS,
      // DELIBERATELY EMPTY. `excludedRows` means "rows that belong to the
      // universe but were withheld from the totals", and neither disclosure
      // below is that: an orphan movement belongs to no tenant and is not in
      // this company's universe at all, and a stocktake note is a statement
      // about data rather than a row. Passing them here fails the envelope's
      // rowsTotal + excludedRows.length === universeTotal identity and emits a
      // completenessFault whose cause is a DISCLOSURE, not a lost row — the
      // misleading signal envelope.ts calls worse than none.
      //
      // `excludedTotal: 0` would silence the fault while still presenting a
      // disclosure as an exclusion: true in magnitude, wrong in kind. They are
      // surfaced OUTSIDE the identity instead, as chart_of_accounts_health
      // does with accountsTotal/accountsClean.
      excludedRows: [],
    });

    return ok({
      ...envelope,
      total_quantity: v.totalQuantity,
      total_value: v.totalValue,
      unvalued_product_count: v.unvaluedProductCount,
      // Facts about data this report could NOT draw from, stated outside the
      // completeness identity because they are not members of the universe.
      disclosures: v.disclosures,
    });
  },
};

export const supplierStatementTool: McpTool = {
  name: 'supplier_statement',
  description:
    'A running-balance statement of account for one supplier: every bill, payment and supplier credit note dated on or before as_at, in date order, with what we owe after each. The mirror of customer_statement, and it runs the OTHER WAY — a bill credits the balance (we owe more), a payment debits it (we owe less), and a positive closing balance means we owe the supplier. ' +
    'It runs from INCEPTION to as_at, not over a rolling window; from_date reports the date of the earliest transaction it actually found. ' +
    'Cancelled bills are omitted. A payment that has not been PROCESSED does not reduce what we owe and appears in excludedRows with its amount — there are 56 draft supplier payments on these books, and a payment sitting in draft is a different problem from one that was never raised. Credit notes count whether they are approved or already applied. ' +
    'This is OUR ledger of the supplier. It is not the reconciliation of a statement the supplier sent us — that is supplier_statement_reconciliations in the app, and this tool does not read it. detail: "summary" returns the totals with no rows.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Supplier UUID from list_suppliers.' },
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['supplier_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['supplier_id'], date: ['as_at'] });
    if (guard) return guard;
    const supplierId = strArg(args, 'supplier_id');
    if (!supplierId) return toolError('supplier_id is required');

    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
    const detail = detailOf(args);

    const data = await fetchSupplierStatementData(ctx.companyId, supplierId, asAt);
    if (!data) return toolError(NOT_FOUND);

    const rows = data.transactions.map((t) => ({
      date: t.date,
      type: t.type,
      reference: t.reference,
      debit: t.debit,
      credit: t.credit,
      balance: t.balance,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      universeTotal: data.universeTotal,
      detail,
      as_at: asAt,
      posted_through: data.postedThrough ?? NO_LEDGER_ROWS,
      excludedRows: data.excluded as ExcludedRow[],
      figureBasis: figureBasis('ap.subledger.v1'),
    });

    return ok({
      ...envelope,
      supplier: data.supplier,
      from_date: data.fromDate,
      summary: data.summary,
    });
  },
};
