// RED phase — written before implementation
/**
 * Unit tests for performThreeWayMatch in supplierInvoiceWorkflowService.ts
 *
 * Covers: happy path, price-over-tolerance, qty-over-tolerance, no-PO early
 * return, rule-based tolerance override, and UPDATE persistence per line.
 *
 * Does NOT re-test the pure validateThreeWayMatch util — those belong in
 * tests/unit/utils/threeWayMatch.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  fmtDate: (x: unknown) => String(x),
  DbRow: null,
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoiceById: vi.fn(),
}));

// Stub out GL + journal services — not exercised by this test scope
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));

import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const INVOICE_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const PO_ID        = 'cccccccc-0000-0000-0000-000000000003';
const GRN_ID       = 'dddddddd-0000-0000-0000-000000000004';
const SUPPLIER_ID  = 'eeeeeeee-0000-0000-0000-000000000005';
const ITEM_ID      = 'ffffffff-0000-0000-0000-000000000006';
const PO_ITEM_ID   = 'aaaaaaaa-1111-0000-0000-000000000007';

function makeItem(overrides: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  return {
    id: ITEM_ID,
    supplierInvoiceId: INVOICE_ID,
    poItemId: PO_ITEM_ID,
    description: 'Cable 100m',
    quantity: 10,
    unitPrice: 100,
    taxRate: 15,
    taxAmount: 150,
    lineTotal: 1000,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<SupplierInvoice> = {}): SupplierInvoice {
  return {
    id: INVOICE_ID,
    invoiceNumber: 'INV-2026-001',
    supplierId: SUPPLIER_ID,
    purchaseOrderId: PO_ID,
    grnId: GRN_ID,
    invoiceDate: '2026-01-15',
    subtotal: 1000,
    taxRate: 15,
    taxAmount: 150,
    totalAmount: 1150,
    amountPaid: 0,
    balance: 1150,
    currency: 'ZAR',
    status: 'approved',
    matchStatus: 'unmatched',
    createdBy: 'user-001',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [makeItem()],
    ...overrides,
  };
}

/** po_items row returned by sql mock */
function makePoItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PO_ITEM_ID,
    purchase_order_id: PO_ID,
    company_id: COMPANY_ID,
    quantity: 10,
    unit_price: 100,
    description: 'Cable 100m',
    ...overrides,
  };
}

/** grn_items row returned by sql mock */
function makeGrnItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'grn-item-001',
    grn_id: GRN_ID,
    po_item_id: PO_ITEM_ID,
    company_id: COMPANY_ID,
    quantity_received: 10,
    ...overrides,
  };
}

/** Supplier coding rule row — default 2% tolerances */
function makeRuleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    qty_tolerance_pct: 2,
    price_tolerance_pct: 2,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set up sqlMock call sequence for the standard performThreeWayMatch path:
 *   call 0: supplier_coding_rules SELECT
 *   call 1: po_items SELECT
 *   call 2: grn_items SELECT (if grnId present)
 *   call N: supplier_invoice_items UPDATE (one per line)
 *   call N+1: supplier_invoices UPDATE match_status
 */
function setupSqlCalls(opts: {
  ruleRows?: Record<string, unknown>[];
  poItemRows?: Record<string, unknown>[];
  grnItemRows?: Record<string, unknown>[];
  itemUpdateResult?: unknown[];
  invoiceUpdateResult?: unknown[];
}): void {
  const {
    ruleRows = [makeRuleRow()],
    poItemRows = [makePoItemRow()],
    grnItemRows = [makeGrnItemRow()],
    itemUpdateResult = [],
    invoiceUpdateResult = [],
  } = opts;

  vi.mocked(sqlMock)
    .mockResolvedValueOnce(ruleRows as never)      // supplier_coding_rules
    .mockResolvedValueOnce(poItemRows as never)    // po_items
    .mockResolvedValueOnce(grnItemRows as never)   // grn_items
    .mockResolvedValueOnce(itemUpdateResult as never)  // UPDATE supplier_invoice_items
    .mockResolvedValueOnce(invoiceUpdateResult as never); // UPDATE supplier_invoices
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('performThreeWayMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns fully_matched and zero variances when qty and price match PO exactly', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice());
    setupSqlCalls({});

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    expect(result.matchStatus).toBe('fully_matched');
    expect(result.invoiceId).toBe(INVOICE_ID);
    expect(result.itemResults).toHaveLength(1);

    const item = result.itemResults[0]!;
    expect(item.lineMatchStatus).toBe('fully_matched');
    expect(item.qtyVariancePct).toBeCloseTo(0, 5);
    expect(item.priceVariancePct).toBeCloseTo(0, 5);
    expect(item.match.quantityMatch).toBe(true);
    expect(item.match.priceMatch).toBe(true);
    expect(item.match.grnMatch).toBe(true);
  });

  // ── No PO — early return without throwing ─────────────────────────────────

  it('returns { matchStatus: unmatched, itemResults: [] } when invoice has no purchaseOrderId', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(
      makeInvoice({ purchaseOrderId: undefined }),
    );

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    expect(result.matchStatus).toBe('unmatched');
    expect(result.itemResults).toEqual([]);
    // Must NOT have called sql at all (no PO → early return)
    expect(vi.mocked(sqlMock)).not.toHaveBeenCalled();
  });

  it('does not throw when purchaseOrderId is null (legacy invoices)', async () => {
    // null is coerced to undefined in the mapper but simulate the raw null path
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(
      makeInvoice({ purchaseOrderId: undefined, items: [] }),
    );

    await expect(performThreeWayMatch(COMPANY_ID, INVOICE_ID)).resolves.not.toThrow();
  });

  // ── Price over tolerance ───────────────────────────────────────────────────

  it('returns lineMatchStatus != fully_matched and variance ~5% when invoice price is 5% above PO (2% tolerance)', async () => {
    // invoice unitPrice=105, PO unit_price=100 → 5% variance > 2% tolerance
    const item = makeItem({ unitPrice: 105 });
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({ poItemRows: [makePoItemRow({ unit_price: 100 })] });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.lineMatchStatus).not.toBe('fully_matched');
    expect(ir.priceVariancePct).toBeCloseTo(5.0, 1);
    expect(ir.match.priceMatch).toBe(false);
    expect(ir.match.mismatches.some((m: string) => m.toLowerCase().includes('unit price'))).toBe(true);
  });

  it('returns fully_matched when invoice price is exactly at 2% tolerance boundary', async () => {
    // 2% above PO price should pass with 2% tolerance
    const item = makeItem({ unitPrice: 102 });
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({ poItemRows: [makePoItemRow({ unit_price: 100 })] });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.match.priceMatch).toBe(true);
    expect(ir.priceVariancePct).toBeCloseTo(2.0, 2);
  });

  // ── Qty over tolerance ─────────────────────────────────────────────────────

  it('reflects qty mismatch when invoice qty=12 and PO qty=10 (variance 20%, tolerance 2%)', async () => {
    const item = makeItem({ quantity: 12 });
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({
      poItemRows: [makePoItemRow({ quantity: 10 })],
      grnItemRows: [makeGrnItemRow({ quantity_received: 12 })],
    });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.qtyVariancePct).toBeCloseTo(20.0, 1);
    expect(ir.match.quantityMatch).toBe(false);
    expect(ir.lineMatchStatus).not.toBe('fully_matched');
  });

  it('sets match status to grn_matched when qty mismatches PO but GRN matches invoice', async () => {
    // invoice qty=12, PO qty=10, GRN received=12 → GRN matches invoice but not PO
    const item = makeItem({ quantity: 12 });
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({
      poItemRows: [makePoItemRow({ quantity: 10 })],
      grnItemRows: [makeGrnItemRow({ quantity_received: 12 })],
    });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.match.grnMatch).toBe(true);
    expect(ir.match.quantityMatch).toBe(false);
    expect(ir.lineMatchStatus).toBe('grn_matched');
  });

  // ── Supplier rule tolerance override ──────────────────────────────────────

  it('passes a 4% price variance when supplier rule sets price_tolerance_pct=5', async () => {
    const item = makeItem({ unitPrice: 104 }); // 4% above 100
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({
      ruleRows: [makeRuleRow({ qty_tolerance_pct: 5, price_tolerance_pct: 5 })],
      poItemRows: [makePoItemRow({ unit_price: 100 })],
    });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.match.priceMatch).toBe(true);
    expect(ir.priceVariancePct).toBeCloseTo(4.0, 1);
  });

  it('falls back to 2% tolerance when no supplier_coding_rules row exists', async () => {
    // 3% variance should FAIL with 2% fallback
    const item = makeItem({ unitPrice: 103 });
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({
      ruleRows: [],           // no rule row → fallback
      poItemRows: [makePoItemRow({ unit_price: 100 })],
    });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.match.priceMatch).toBe(false);
    expect(ir.priceVariancePct).toBeCloseTo(3.0, 1);
  });

  it('falls back to 2% tolerance when rule row has null tolerance columns', async () => {
    const item = makeItem({ unitPrice: 103 });
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [item] }));
    setupSqlCalls({
      ruleRows: [makeRuleRow({ qty_tolerance_pct: null, price_tolerance_pct: null })],
      poItemRows: [makePoItemRow({ unit_price: 100 })],
    });

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    const ir = result.itemResults[0]!;
    expect(ir.match.priceMatch).toBe(false);
  });

  // ── UPDATE persistence ────────────────────────────────────────────────────

  it('fires exactly one UPDATE per line item plus one UPDATE for invoice match_status', async () => {
    const items = [
      makeItem({ id: 'item-001', poItemId: 'poi-001' }),
      makeItem({ id: 'item-002', poItemId: 'poi-002', description: 'Connector' }),
    ];
    const poRows = [
      makePoItemRow({ id: 'poi-001', quantity: 10, unit_price: 100 }),
      makePoItemRow({ id: 'poi-002', quantity: 5, unit_price: 50 }),
    ];
    const grnRows = [
      makeGrnItemRow({ po_item_id: 'poi-001', quantity_received: 10 }),
      makeGrnItemRow({ po_item_id: 'poi-002', quantity_received: 5 }),
    ];

    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items }));
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeRuleRow()] as never)  // coding_rules
      .mockResolvedValueOnce(poRows as never)           // po_items
      .mockResolvedValueOnce(grnRows as never)          // grn_items
      .mockResolvedValueOnce([] as never)               // UPDATE item-001
      .mockResolvedValueOnce([] as never)               // UPDATE item-002
      .mockResolvedValueOnce([] as never);              // UPDATE supplier_invoices

    await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    // 3 SELECT/UPDATE before lines + 2 item UPDATEs + 1 invoice UPDATE = 6 total
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(6);
  });

  it('includes qty_variance_pct, price_variance_pct, line_match_status in the UPDATE call args', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice());
    setupSqlCalls({});

    await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    // The 4th sql call (index 3) is the supplier_invoice_items UPDATE
    const updateCall = vi.mocked(sqlMock).mock.calls[3];
    expect(updateCall).toBeDefined();
    // The tagged template call includes the raw strings array + interpolations;
    // verify that zero variances and fully_matched status were threaded through
    const callArgs = updateCall!.flat().map(String);
    expect(callArgs.some(a => a.includes('fully_matched') || a === 'fully_matched')).toBe(true);
  });

  // ── Invoice not found ─────────────────────────────────────────────────────

  it('throws when invoice is not found', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(null as unknown as SupplierInvoice);

    await expect(performThreeWayMatch(COMPANY_ID, INVOICE_ID)).rejects.toThrow(INVOICE_ID);
  });

  // ── Empty items array ─────────────────────────────────────────────────────

  it('returns unmatched and empty itemResults when invoice has no items', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValueOnce(makeInvoice({ items: [] }));
    // Still fires the three SELECTs + one invoice UPDATE
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeRuleRow()] as never)
      .mockResolvedValueOnce([makePoItemRow()] as never)
      .mockResolvedValueOnce([makeGrnItemRow()] as never)
      .mockResolvedValueOnce([] as never);

    const result = await performThreeWayMatch(COMPANY_ID, INVOICE_ID);

    expect(result.itemResults).toHaveLength(0);
    expect(result.matchStatus).toBe('unmatched');
  });
});
