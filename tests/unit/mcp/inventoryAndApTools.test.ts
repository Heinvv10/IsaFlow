/**
 * MCP tools: list_items, stock_valuation, supplier_statement.
 *
 * The load-bearing properties:
 *   - stock_valuation must not present R0 as a valuation somebody computed.
 *     Every movement in these books is a purchase carrying total_cost 0.00, so
 *     stock has been received and never valued, and the report has to say that
 *     rather than return a plausible-looking zero.
 *   - stock_movements has no company_id of its own. A movement whose product
 *     has no tenant must not be attributed to the caller, and must not vanish.
 *   - supplier_statement runs the OTHER WAY to the customer one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/items/itemService', () => ({ listItems: vi.fn() }));
vi.mock('@/modules/accounting/services/items/stockValuationService', () => ({
  getStockValuation: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierStatementService', () => ({
  fetchSupplierStatementData: vi.fn(),
}));

import { listItems } from '@/modules/accounting/services/items/itemService';
import { getStockValuation } from '@/modules/accounting/services/items/stockValuationService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import {
  listItemsTool,
  stockValuationTool,
  supplierStatementTool,
} from '@/lib/mcp/tools/inventoryAndAp';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';
const SUPPLIER = '44444444-4444-4444-4444-444444444444';

const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333',
  companyId: COMPANY,
  scopes: ['read:reports'],
  tokenJti: 'j',
  oauthAppId: null,
};

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

/** Stock received and never valued — the actual production shape. */
const VALUATION = {
  rows: [{
    productId: 'p1', code: 'FIB-001', name: 'Fibre cable 1km', unit: 'each',
    quantityOnHand: 240, value: 0, averageCost: 0, movementCount: 240, unvalued: true,
  }],
  rowsTotal: 1,
  // universeTotal is THIS COMPANY'S products, so it equals rowsTotal here. The
  // fixture used to say 2 — satisfying the old `rowsTotal + excluded.length`
  // formula — and was never updated when the service stopped counting
  // disclosures as members of the universe.
  universeTotal: 1,
  // Disclosures, NOT exclusions: an orphan movement is not in this company's
  // universe at all, and a stocktake note is a statement about data rather than
  // a row. Neither carries a count or a value — the orphan query cannot be
  // scoped by company_id, so any figure would come from other tenants' rows.
  disclosures: [
    {
      id: 'orphan_movements', reason: 'product_has_no_company',
      detail: 'Stock movements exist against products carrying no company_id.',
    },
    {
      id: 'stocktake_counts', reason: 'stocktake_count_not_a_delta',
      detail: 'Stocktake movements record an absolute quantity rather than a change.',
    },
  ],
  totalValue: 0,
  totalQuantity: 240,
  unvaluedProductCount: 1,
  postedThrough: '2026-08-01T10:00:00.000Z',
};

const SUPPLIER_STATEMENT = {
  supplier: { id: SUPPLIER, name: 'Fibre Supplies CC', email: 'ar@fibre.example' },
  fromDate: '2026-01-10',
  toDate: '2026-03-31',
  transactions: [
    { date: '2026-01-10', type: 'invoice' as const, reference: 'SI0001', debit: 0, credit: 20000, balance: 20000 },
    { date: '2026-02-05', type: 'payment' as const, reference: 'SP0001', debit: 8000, credit: 0, balance: 12000 },
  ],
  excluded: [{
    id: 'p2', reason: 'payment_not_processed', detail: "Payment is 'draft'",
    amount: 5000, documentNumber: 'SP0002',
  }],
  universeTotal: 3,
  summary: { totalInvoiced: 20000, totalPaid: 8000, totalCredits: 0, balance: 12000 },
  postedThrough: '2026-02-05T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listItems).mockResolvedValue([]);
  vi.mocked(getStockValuation).mockResolvedValue(VALUATION);
  vi.mocked(fetchSupplierStatementData).mockResolvedValue(SUPPLIER_STATEMENT);
});

describe('registration', () => {
  it('all three are registered, mirrored, and read-only', () => {
    for (const n of ['list_items', 'stock_valuation', 'supplier_statement']) {
      expect(MCP_TOOLS.map((t) => t.name)).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
    }
    for (const t of [listItemsTool, stockValuationTool, supplierStatementTool]) {
      expect(t.write).toBe(false);
    }
  });
});

describe('list_items', () => {
  it('returns a sound envelope for an empty catalogue rather than a bare []', async () => {
    const env = json(await listItemsTool.handler({}, ctx));
    expect(env.rows).toEqual([]);
    expect(env.rowsTotal).toBe(0);
    expect(env.truncated).toBe(false);
    expect(env.completenessFault).toBeUndefined();
  });

  it('says in its description that the catalogue is separate from stock', () => {
    // An empty result here means nothing has been catalogued, not that there is
    // no stock. A reader who conflates the two will conclude the wrong thing.
    expect(listItemsTool.description).toMatch(/products/i);
    expect(listItemsTool.description).toMatch(/stock_valuation/);
  });

  it('takes the company from the context, never from args', async () => {
    await listItemsTool.handler({ company_id: OTHER }, ctx);
    expect(vi.mocked(listItems).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('drops an out-of-range enum value instead of passing it to the service', async () => {
    // additionalProperties: false and a JSON Schema enum are ADVISORY — nothing
    // in this server validates against the schema — so an agent can send
    // anything. It must not reach a service that types the argument as a
    // literal union and builds a SQL fragment from it.
    await listItemsTool.handler({ type: "physical' OR '1'='1", active: 'maybe' }, ctx);
    const filters = vi.mocked(listItems).mock.calls[0]![1]!;
    expect(filters.type).toBeUndefined();
    expect(filters.active).toBeUndefined();
  });

  it('passes a valid enum value through', async () => {
    await listItemsTool.handler({ type: 'service', active: 'true' }, ctx);
    const filters = vi.mocked(listItems).mock.calls[0]![1]!;
    expect(filters.type).toBe('service');
    expect(filters.active).toBe('true');
  });

  it('refuses a malformed category_id before it reaches a cast', async () => {
    const res = await listItemsTool.handler({ category_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(listItems).not.toHaveBeenCalled();
  });
});

describe('stock_valuation — zero is not a valuation', () => {
  it('flags a product carrying quantity against no cost', async () => {
    const env = json(await stockValuationTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(env.rows[0].quantity_on_hand).toBe(240);
    expect(env.rows[0].value).toBe(0);
    expect(env.rows[0].unvalued).toBe(true);
    expect(env.unvalued_product_count).toBe(1);
  });

  it('reports movements whose product has no tenant, and does not claim them', async () => {
    const env = json(await stockValuationTool.handler({ as_at: '2026-08-31' }, ctx));
    const ex = env.disclosures.find(
      (e: { reason: string }) => e.reason === 'product_has_no_company',
    );
    expect(ex).toBeDefined();
    // No amount, and no digit in the detail: that query cannot be scoped by
    // company_id, so any figure it produced would come from rows that may
    // belong to other tenants.
    expect(ex.amount).toBeUndefined();
    expect(ex.detail).not.toMatch(/\d/);
    // They are outside the total, not inside it.
    expect(env.total_value).toBe(0);
  });

  it('pins posted_through to the ledger, not to now()', async () => {
    const env = json(await stockValuationTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(env.posted_through).toBe('2026-08-01T10:00:00.000Z');
  });

  it('takes the company from the context, never from args', async () => {
    await stockValuationTool.handler({ as_at: '2026-08-31', company_id: OTHER }, ctx);
    expect(vi.mocked(getStockValuation).mock.calls[0]![0]).toBe(COMPANY);
  });
});

describe('supplier_statement — the payable runs the other way', () => {
  it('a bill credits the balance and a payment debits it', async () => {
    const env = json(await supplierStatementTool.handler(
      { supplier_id: SUPPLIER, as_at: '2026-03-31' }, ctx,
    ));
    expect(env.rows[0].credit).toBe(20000);
    expect(env.rows[1].debit).toBe(8000);
    // Positive means we owe the supplier.
    expect(env.summary.balance).toBe(12000);
  });

  it('carries the excluded draft payment and its amount', async () => {
    const env = json(await supplierStatementTool.handler(
      { supplier_id: SUPPLIER, as_at: '2026-03-31' }, ctx,
    ));
    expect(env.excludedRows[0].reason).toBe('payment_not_processed');
    expect(env.excludedRows[0].amount).toBe(5000);
    expect(env.rowsTotal + env.excludedRows.length).toBe(3);
    expect(env.completenessFault).toBeUndefined();
  });

  it('names the AP subledger as its figure basis', async () => {
    const env = json(await supplierStatementTool.handler(
      { supplier_id: SUPPLIER, as_at: '2026-03-31' }, ctx,
    ));
    expect(env.figureBasis).toBe('ap.subledger.v1');
  });

  it('refuses a supplier in another company with the shared not-found text', async () => {
    vi.mocked(fetchSupplierStatementData).mockResolvedValue(null);
    const res = await supplierStatementTool.handler(
      { supplier_id: SUPPLIER, as_at: '2026-03-31' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
  });

  it('takes the company from the context, never from args', async () => {
    await supplierStatementTool.handler(
      { supplier_id: SUPPLIER, as_at: '2026-03-31', company_id: OTHER }, ctx,
    );
    expect(vi.mocked(fetchSupplierStatementData).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses a malformed supplier_id before it reaches a cast', async () => {
    const res = await supplierStatementTool.handler({ supplier_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchSupplierStatementData).not.toHaveBeenCalled();
  });
});

describe('stock_valuation — a disclosure must not read as a lost row', () => {
  it('raises no completenessFault when disclosures are present', async () => {
    const res = await stockValuationTool.handler({}, ctx);
    const body = json(res);

    // buildEnvelope checks rowsTotal + excludedRows.length === universeTotal.
    // Passing disclosures as excludedRows while universeTotal counts only this
    // company's products fails that identity and emits a fault whose cause is a
    // DISCLOSURE, not a row that went missing — the misleading signal the
    // envelope's own docstring calls worse than none.
    expect(body.completenessFault).toBeUndefined();
    expect(body.rowsTotal).toBe(1);
    // universeTotal is an INPUT to buildEnvelope's check, never part of its
    // output — the envelope reports the fault, not the universe.
    expect(body.universeTotal).toBeUndefined();
  });

  it('still surfaces both disclosures somewhere the reader can see them', async () => {
    const body = json(await stockValuationTool.handler({}, ctx));
    const text = JSON.stringify(body);
    expect(text).toContain('product_has_no_company');
    expect(text).toContain('stocktake_count_not_a_delta');
  });

  it('reports no unattributable movements as excluded rows', async () => {
    const body = json(await stockValuationTool.handler({}, ctx));
    // They are disclosures about data outside the universe, so the envelope's
    // excludedRows — "rows that belong to the universe but were withheld from
    // the totals" — is the wrong home for them.
    expect(body.excludedRows ?? []).toHaveLength(0);
  });
});
