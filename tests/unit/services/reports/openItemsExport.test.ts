/**
 * ap_open_items / ar_open_items — the control: Σ Outstanding equals the
 * aged_creditors / aged_debtors net `total` to the cent.
 *
 * The two sides are computed by DIFFERENT code from the SAME fixture: the aged
 * tools run their own path (getAPAging / getARAging → calculateAgingBuckets,
 * getUnappliedByEntity → netAgingRows, round2 of Σ net), the export builds one
 * row per document and adds them up. Only the two data fetchers are replaced —
 * the open bills and the per-document unapplied credit — so both paths read
 * identical data and everything after the fetch is real code.
 *
 * The fixture is chosen to break a naive export: cents that float-sum badly,
 * a disputed invoice (out of the AR buckets), a refund, an entity with credit
 * and no open invoice (a report row of its own), and an entity whose
 * on-account entries net to R0.01 (no report row, so no export rows either).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenAgingInvoice } from '@/modules/accounting/utils/aging';
import type { UnappliedDocument } from '@/modules/accounting/services/shared/unappliedDocuments';

const fx = vi.hoisted(() => ({
  ap: [] as unknown[], ar: [] as unknown[], apDocs: [] as unknown[], arDocs: [] as unknown[],
}));

vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/apAgingInvoices', () => ({
  fetchAPAgingInvoices: vi.fn(async () => fx.ap),
}));
vi.mock('@/modules/accounting/services/ar/arAgingInvoices', () => ({
  fetchARAgingInvoices: vi.fn(async () => fx.ar),
}));
vi.mock('@/modules/accounting/services/shared/unappliedDocuments', () => ({
  getUnappliedDocuments: vi.fn(async (_c: string, side: string) => (side === 'ap' ? fx.apDocs : fx.arDocs)),
}));
vi.mock('@/modules/accounting/services/reports/openItemsLookups', () => ({
  invoiceDimensions: vi.fn(async () => new Map([['i-a1', { cc1: 'FT', cc2: 'MIXED', bu: null }]])),
  creditNoteDimensions: vi.fn(async () => new Map([['cn-1', { cc1: 'LFI', cc2: null, bu: 'BU1' }]])),
  documentsOnFile: vi.fn(async () => new Set(['i-a1', 'p-1'])),
}));
const NONE = { rows: [], rowsTotal: 0, universeTotal: 0, unattributed: [], totalUnapplied: 0, totalUnattributed: 0, postedThrough: null };
vi.mock('@/modules/accounting/services/ap/unappliedPaymentService', () => ({ getUnappliedPayments: vi.fn(async () => NONE) }));
vi.mock('@/modules/accounting/services/ar/unappliedReceiptService', () => ({ getUnappliedReceipts: vi.fn(async () => NONE) }));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn(async () => '2026-10-22T08:00:00.000Z'),
}));

import { buildOpenItems, OPEN_ITEMS_COLUMNS } from '@/modules/accounting/services/reports/openItemsExport';
import { agedCreditorsTool, agedDebtorsTool } from '@/lib/mcp/tools/reportsAging';
import type { McpToolContext } from '@/lib/mcp/types';

const AS_AT = '2026-10-22';
const CTX = { userId: 'u', companyId: '11111111-1111-4111-8111-111111111111', scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const payload = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
const cents = (n: unknown) => Math.round(Number(n) * 100);

function inv(id: string, entityId: string, balance: number, dueDate: string, extra: Partial<OpenAgingInvoice> = {}): OpenAgingInvoice {
  return {
    id, invoiceNumber: `N-${id}`, entityId, entityName: `Name ${entityId}`, dueDate, dueDateMissing: false,
    totalAmount: balance + 10, amountPaid: 10, balance, invoiceDate: '2026-01-01', reference: `R-${id}`, ...extra,
  };
}
function doc(id: string, kind: UnappliedDocument['kind'], entityId: string, amount: number, date = '2026-06-01'): UnappliedDocument {
  return {
    kind, id, number: `D-${id}`, date, entityId, entityName: `Name ${entityId}`, totalAmount: amount, amount,
    reference: null, cc1Id: null, cc2Id: null, buId: null,
  };
}

beforeEach(() => {
  fx.ap = [
    inv('i-a1', 's1', 1000.10, '2026-07-14'),           // 100 days overdue → 90 < d → 120+
    inv('i-a2', 's1', 250.55, '2026-10-30'),            // not yet due → current
    inv('i-a3', 's2', 0.1, '2026-09-22'),               // 30 days → '30'
    inv('i-a4', 's2', 0.2, '2026-08-23'),               // 60 days → '60'
    inv('i-a5', 's4', 33.33, 'not-a-date'),             // unusable date → 120+, no day count
  ];
  fx.apDocs = [
    doc('cn-1', 'credit_note', 's1', 115.1),
    doc('p-1', 'payment', 's1', 200),
    doc('p-2', 'payment', 's3', 300),                   // credit, no open bill: a report row of its own
    doc('p-3', 'payment', 's5', 100),                   // these two net to 0.01 with no open bill:
    doc('r-1', 'payment', 's5', -99.99),                //   no report row, so no export rows
    doc('r-2', 'payment', 's2', -0.3),                  // a refund nets the other way
  ];
  fx.ar = [
    inv('c-1', 'k1', 100, '2026-09-01', { disputedAmount: 40 }),
    inv('c-2', 'k1', 59.99, '2026-10-01'),
    inv('c-3', 'k2', 1234.56, '2026-01-01'),
  ];
  fx.arDocs = [doc('cn-9', 'credit_note', 'k2', 34.56), doc('rc-1', 'payment', 'k3', 500)];
});

describe('ap_open_items: the control against aged_creditors', () => {
  it('Σ Outstanding equals aged_creditors total, gross_total and buckets to the cent', async () => {
    const out = await buildOpenItems(CTX.companyId, 'ap', AS_AT);
    const aged = payload(await agedCreditorsTool.handler({ as_at: AS_AT }, CTX));

    const rowSum = out.rows.reduce((s, r) => s + cents(r.Outstanding), 0);
    expect(rowSum).toBe(cents(aged.total));
    expect(cents(out.summary.controlTotal)).toBe(cents(aged.total));
    expect(cents(out.summary.agedTotal)).toBe(cents(aged.total));
    expect(out.summary.difference).toBe(0);
    expect(cents(out.summary.grossTotal)).toBe(cents(aged.gross_total));

    const b = aged.buckets as Record<string, number>;
    expect(out.summary.buckets).toEqual({
      current: b.current, '30': b.days30, '60': b.days60, '90': b.days90, '120+': b.days120Plus,
    });
    // The figure itself, worked by hand: 1284.28 gross − 115.10 − 200 − 300 + 0.30.
    expect(out.summary.controlTotal).toBe(669.48);
  });

  it('leaves out the documents of an entity the report has no row for (net R0.01, no open bill)', async () => {
    const out = await buildOpenItems(CTX.companyId, 'ap', AS_AT);
    const ids = out.rows.map((r) => r.Doc_ID);
    expect(ids).not.toContain('p-3');
    expect(ids).not.toContain('r-1');
    expect(ids).toContain('p-2');
    expect(out.summary.rowCount).toBe(9);
  });

  it('writes the fixed column order, signs credit negative and ages from the aging\'s due date', async () => {
    const out = await buildOpenItems(CTX.companyId, 'ap', AS_AT);
    expect(out.columns).toEqual([
      'Doc_ID', 'Doc_Type', 'Doc_No', 'Supplier_Ref', 'Counterparty_ID', 'Counterparty_Name', 'Doc_Date',
      'Due_Date', 'Days_Overdue', 'Age_Bucket', 'Total_Incl_VAT', 'Outstanding', 'Disputed', 'CC1_Code',
      'CC2_Code', 'BU_Code', 'Has_Document', 'Schema_Version',
    ]);
    const byId = new Map(out.rows.map((r) => [r.Doc_ID, r]));
    expect(byId.get('i-a1')).toMatchObject({
      Doc_Type: 'invoice', Days_Overdue: 100, Age_Bucket: '120+', Outstanding: 1000.1, CC1_Code: 'FT',
      CC2_Code: 'MIXED', BU_Code: null, Has_Document: true, Supplier_Ref: 'R-i-a1', Due_Date: '2026-07-14',
    });
    expect(byId.get('i-a2')).toMatchObject({ Days_Overdue: -8, Age_Bucket: 'current', Has_Document: false });
    expect(byId.get('i-a3')).toMatchObject({ Age_Bucket: '30', Days_Overdue: 30 });
    expect(byId.get('i-a4')).toMatchObject({ Age_Bucket: '60', Days_Overdue: 60 });
    expect(byId.get('i-a5')).toMatchObject({ Age_Bucket: '120+', Days_Overdue: null });
    // Credit and cash rows are not aged: the report does not bucket them.
    expect(byId.get('cn-1')).toMatchObject({
      Doc_Type: 'credit_note', Outstanding: -115.1, Total_Incl_VAT: -115.1, Due_Date: null, CC1_Code: 'LFI', BU_Code: 'BU1',
      Days_Overdue: null, Age_Bucket: null,
    });
    expect(byId.get('p-1')).toMatchObject({
      Doc_Type: 'unapplied_payment', Outstanding: -200, Has_Document: true, Days_Overdue: null, Age_Bucket: null,
    });
    expect(byId.get('r-2')).toMatchObject({ Doc_Type: 'unapplied_payment', Outstanding: 0.3 });
    // A total order the cursor can key on: (Doc_Type, Doc_ID).
    const keys = out.rows.map((r) => `${String(r.Doc_Type)}|${String(r.Doc_ID)}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('ar_open_items: the control against aged_debtors', () => {
  it('Σ Outstanding equals aged_debtors total; a disputed amount is out of Outstanding and stated', async () => {
    const out = await buildOpenItems(CTX.companyId, 'ar', AS_AT);
    const aged = payload(await agedDebtorsTool.handler({ as_at: AS_AT }, CTX));

    expect(out.rows.reduce((s, r) => s + cents(r.Outstanding), 0)).toBe(cents(aged.total));
    expect(cents(out.summary.controlTotal)).toBe(cents(aged.total));
    expect(cents(out.summary.grossTotal)).toBe(cents(aged.gross_total));
    expect(out.summary.difference).toBe(0);
    expect(out.columns).toEqual(OPEN_ITEMS_COLUMNS.ar);
    expect(out.columns[3]).toBe('Customer_Ref');
    const c1 = out.rows.find((r) => r.Doc_ID === 'c-1')!;
    expect(c1).toMatchObject({ Outstanding: 60, Disputed: 40 });
    expect(out.rows.find((r) => r.Doc_ID === 'rc-1')).toMatchObject({ Doc_Type: 'unapplied_receipt', Outstanding: -500 });
    // 60 + 59.99 + 1234.56 − 34.56 − 500.
    expect(out.summary.controlTotal).toBe(819.99);
  });
});

/** Σ Outstanding per Age_Bucket, in cents; credit and cash rows land under 'none'. */
function pivot(rows: ReadonlyArray<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r.Age_Bucket === null ? 'none' : String(r.Age_Bucket);
    out[k] = (out[k] ?? 0) + cents(r.Outstanding);
  }
  return out;
}

describe('open items: what a dashboard does with the file', () => {
  it('a pivot of Outstanding by Age_Bucket gives the report\'s gross buckets, plus the unapplied total unbucketed', async () => {
    const out = await buildOpenItems(CTX.companyId, 'ap', AS_AT);
    const aged = payload(await agedCreditorsTool.handler({ as_at: AS_AT }, CTX));
    const b = aged.buckets as Record<string, number>;
    const p = pivot(out.rows);
    expect(p).toEqual({
      current: cents(b.current), '30': cents(b.days30), '60': cents(b.days60), '120+': cents(b.days120Plus),
      none: cents(out.summary.unappliedTotal),
    });
    expect(b.days90).toBe(0);
  });

  it('states the disputed total, so Σ Outstanding + disputedTotal is what the invoices still owe', async () => {
    const ar = await buildOpenItems(CTX.companyId, 'ar', AS_AT);
    expect(ar.summary.disputedTotal).toBe(40);
    const balances = fx.ar.reduce((s: number, i) => s + cents((i as OpenAgingInvoice).balance), 0);
    expect(cents(ar.summary.grossTotal) + cents(ar.summary.disputedTotal)).toBe(balances);
    // AP has no dispute concept.
    expect((await buildOpenItems(CTX.companyId, 'ap', AS_AT)).summary.disputedTotal).toBe(0);
  });
});

describe('open items: entities the main fixture does not reach', () => {
  it('a refund-only entity, a credit larger than the invoices, the 90-day edge and a non-positive balance still tie', async () => {
    fx.ap = [
      ...fx.ap,
      inv('i-90', 's7', 70, '2026-07-24'),               // exactly 90 days → '90'
      inv('i-91', 's7', 80, '2026-07-23'),               // 91 days → '120+'
      inv('i-x', 's8', 10, '2026-10-01'),                // credit 50 > this invoice: entity nets −40
      inv('i-0', 's9', 0, '2026-10-01'),                 // no balance: the report drops it
      inv('i-neg', 's9', -5, '2026-10-01'),              // over-settled: the report drops it
    ];
    fx.apDocs = [...fx.apDocs, doc('cn-x', 'credit_note', 's8', 50), doc('r-6', 'payment', 's6', -25)]; // s6: refund only
    const out = await buildOpenItems(CTX.companyId, 'ap', AS_AT);
    const aged = payload(await agedCreditorsTool.handler({ as_at: AS_AT }, CTX));

    expect(out.rows.reduce((s, r) => s + cents(r.Outstanding), 0)).toBe(cents(aged.total));
    expect(out.summary.difference).toBe(0);
    const byId = new Map(out.rows.map((r) => [r.Doc_ID, r]));
    expect(byId.get('i-90')).toMatchObject({ Days_Overdue: 90, Age_Bucket: '90' });
    expect(byId.get('i-91')).toMatchObject({ Days_Overdue: 91, Age_Bucket: '120+' });
    expect(byId.get('r-6')).toMatchObject({ Outstanding: 25, Counterparty_ID: 's6' });
    expect(byId.get('cn-x')).toMatchObject({ Outstanding: -50 });
    expect(byId.has('i-0')).toBe(false);
    expect(byId.has('i-neg')).toBe(false);
    // Hand-worked: 669.48 + 70 + 80 + 10 − 50 + 25.
    expect(out.summary.controlTotal).toBe(804.48);
  });
});
