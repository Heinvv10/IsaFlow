/** What a re-run compares of a PO already in the books, column by column, against what the PO tool would write. PURE. */
import { describe, expect, it } from 'vitest';
import {
  PO_HEADER_COMPARED, PO_HEADER_EXCLUDED, PO_LINE_COMPARED, PO_LINE_EXCLUDED, poContentDifferences, storedPoFrom, withContentDifferences,
  type HeaderColumn, type LineColumn, type PoContent, type Scalar, type StoredPo,
} from '@/modules/accounting/services/sage-migration/sagePoContent';

const S1 = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const S2 = '1a7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f7';
const ITEM = '2b7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f8';
const ACC = '3c7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f9';

const header = (over: Partial<Record<HeaderColumn, Scalar>> = {}): Record<HeaderColumn, Scalar> => ({
  po_number: 'PO1', supplier_id: S1, order_date: '2026-02-01', expected_delivery_date: '2026-03-01', status: 'approved', subtotal: 2750.5, tax_amount: 412.58, total: 3163.08,
  reference: 'JOB-1', external_system: 'sage', external_ref: '1', external_document_number: 'PO1', ...over,
});
const line = (n: number, over: Partial<Record<LineColumn, Scalar>> = {}, itemCode: string | null = null) => ({
  itemCode,
  columns: {
    description: n === 0 ? 'Fibre drop cable' : 'Delivery charge', quantity: n === 0 ? 2 : 1, unit_price: n === 0 ? 1200 : 350.5, tax_rate: 15,
    line_total: n === 0 ? 2400 : 350.5, tax_amount: n === 0 ? 360 : 52.58, item_id: null, sort_order: n, ...over,
  } as Record<LineColumn, Scalar>,
});
const sent = (over: { header?: Partial<Record<HeaderColumn, Scalar>>; lines?: StoredPo['lines'] } = {}): StoredPo => ({ header: header(over.header), lines: over.lines ?? [line(0), line(1)] });
/** The books hold what was sent, plus the columns that are never compared. */
const books = (over: { header?: Record<string, unknown>; lines?: Array<Record<string, unknown>> } = {}): PoContent => ({
  header: { id: 'x', company_id: 'c', created_by: 'u', approved_at: '2026-02-01T00:00:00Z', ...header(), ...over.header },
  lines: over.lines ?? [line(0), line(1)].map((l) => ({ id: 'l', purchase_order_id: 'x', quantity_received: 5, created_at: 't', ...l.columns })),
});
const diff = (stored: StoredPo, have: PoContent | undefined, problem?: string) =>
  poContentDifferences({ purchaseOrders: [{ sageId: '1', documentNumber: 'PO1', stored, supplierProblem: problem }] }, new Map(have ? [['1', have]] : []));
const fieldsOf = (d: ReturnType<typeof diff>) => d.flatMap((p) => p.differences.map((x) => x.field));

describe('the column lists', () => {
  it('compared and excluded columns never overlap, and every exclusion has a reason', () => {
    for (const [compared, excluded] of [[PO_HEADER_COMPARED, PO_HEADER_EXCLUDED], [PO_LINE_COMPARED, PO_LINE_EXCLUDED]] as const) {
      for (const c of compared) expect(Object.keys(excluded), c).not.toContain(c);
      for (const reason of Object.values(excluded)) expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('B8-B (round 8): IsaFlow-owned coding never blocks a re-run', () => {
  it('a line coded in IsaFlow (account, CC1, CC2, business unit) or given another account by --po-gl-account is no difference', () => {
    const coded = books({ lines: [line(0), line(1)].map((l) => ({ ...l.columns, gl_account_id: ACC, cc1_id: ACC, cc2_id: ACC, bu_id: ACC })) });
    expect(diff(sent(), coded)).toEqual([]);
    expect(Object.keys(PO_LINE_EXCLUDED)).toEqual(expect.arrayContaining(['gl_account_id', 'cc1_id', 'cc2_id', 'bu_id']));
    expect(PO_LINE_EXCLUDED.gl_account_id).toMatch(/IsaFlow-owned coding/);
  });
});

describe('poContentDifferences: every compared column', () => {
  it('a PO that matches in every compared column has no difference (excluded columns may differ); one not in the books has none to compare', () => {
    expect(diff(sent(), books())).toEqual([]);
    expect(diff(sent(), undefined)).toEqual([]);
  });
  it('each header column is compared: a change in any one is listed under its column name, with both values', () => {
    const changed: Record<HeaderColumn, Scalar> = {
      po_number: 'PO1-R', supplier_id: S2, order_date: '2026-02-02', expected_delivery_date: '2026-03-31', status: 'billed', subtotal: 1, tax_amount: 2, total: 3,
      reference: 'JOB-9', external_system: 'pastel', external_ref: '2', external_document_number: 'PO1-R',
    };
    for (const column of PO_HEADER_COMPARED) {
      const d = diff(sent({ header: { [column]: changed[column] } }), books());
      expect(d, column).toEqual([{ poNumber: 'PO1', differences: [{ field: column, existing: header()[column], requested: changed[column] }] }]);
    }
  });
  it('each line column is compared, by position: a change in any one is listed as "line N <column>"', () => {
    const changed: Record<LineColumn, Scalar> = {
      description: 'Other', quantity: 4, unit_price: 600, tax_rate: 0, line_total: 1, tax_amount: 2, item_id: ITEM, sort_order: 7,
    };
    for (const column of PO_LINE_COMPARED) {
      const d = diff(sent({ lines: [line(0), line(1, { [column]: changed[column] })] }), books());
      expect(d, column).toEqual([{ poNumber: 'PO1', differences: [{ field: `line 2 ${column}`, existing: line(1).columns[column], requested: changed[column] }] }]);
    }
  });
  it('a VAT swap between two lines at the same totals is listed (tax_rate, tax_amount, line_total)', () => {
    const swapped = sent({ lines: [line(0, { tax_rate: 0, tax_amount: 0 }), line(1, { tax_rate: 15, tax_amount: 52.58 })] });
    expect(fieldsOf(diff(swapped, books()))).toEqual(['line 1 tax_rate', 'line 1 tax_amount']);
  });
  it('a line whose item link moved or was dropped is listed (item_id), the books keeping the old link', () => {
    const have = books({ lines: [line(0, { item_id: ITEM }), line(1)].map((l) => ({ ...l.columns })) });
    expect(diff(sent(), have)[0]!.differences).toEqual([{ field: 'line 1 item_id', existing: ITEM, requested: null }]);
    expect(diff(sent({ lines: [line(0, { item_id: S2 }), line(1)] }), have)[0]!.differences).toEqual([{ field: 'line 1 item_id', existing: ITEM, requested: S2 }]);
  });
  it('a line added or removed is one difference, the line count', () => {
    expect(diff(sent({ lines: [line(0)] }), books())[0]!.differences).toEqual([{ field: 'lines', existing: 2, requested: 1 }]);
  });
  it('compares values, not spellings: 2 and 2.00, 350.5 and 350.500000, "" and null, an id in upper case, the system in any case', () => {
    const have = books({
      header: { reference: '', external_system: 'SAGE', supplier_id: S1.toUpperCase(), subtotal: 2750.500000 },
      lines: [line(0, { quantity: Number('2.00'), unit_price: Number('1200.000000') }), line(1, { unit_price: Number('350.500000') })].map((l) => ({ ...l.columns })),
    });
    expect(diff(sent({ header: { reference: null } }), have)).toEqual([]);
  });
  it('a supplier the plan could not resolve is listed under supplier_id with the plan\'s words, and the other columns still compare', () => {
    const problem = `Sage supplier 301 "Alpha" not found in IsaFlow; PO is booked to Alpha Renamed (${S1})`;
    expect(diff(sent({ header: { reference: 'JOB-2' } }), books(), problem)).toEqual([{ poNumber: 'PO1', differences: [
      { field: 'supplier_id', existing: S1, requested: problem },
      { field: 'reference', existing: 'JOB-1', requested: 'JOB-2' },
    ] }]);
    expect(diff(sent(), books(), undefined)).toEqual([]);
  });
});

describe('the " [item CODE]" suffix', () => {
  it('only the exact suffix of the line\'s own item code is stripped, on both sides', () => {
    const have = (d: string) => books({ lines: [line(0, { description: d }), line(1)].map((l) => ({ ...l.columns })) });
    const sentWith = (d: string, code: string | null) => sent({ lines: [line(0, { description: d }, code), line(1)] });
    expect(diff(sentWith('Cable', 'FIB]0001'), have('Cable [item FIB]0001]'))).toEqual([]); // linked on the first run, unlinked now (a "]" in the code)
    expect(diff(sentWith('Cable [item FIB]0001]', 'FIB]0001'), have('Cable'))).toEqual([]);
    expect(diff(sentWith('Cable [item X]', null), have('Cable'))[0]!.differences.map((x) => x.field)).toEqual(['line 1 description']);
    expect(diff(sentWith('Cable [item OTHER]', 'FIB-1'), have('Cable'))[0]!.differences.map((x) => x.field)).toEqual(['line 1 description']);
  });
});

describe('keyed like the tool', () => {
  it('a renumbered PO is listed under the number the books hold', () => {
    const d = poContentDifferences({ purchaseOrders: [{ sageId: '1', documentNumber: 'PO1-NEW', stored: sent({ header: { po_number: 'PO1-NEW' } }) }] }, new Map([['1', books()]]));
    expect(d.map((p) => p.poNumber)).toEqual(['PO1']);
    expect(fieldsOf(d)).toEqual(['po_number']);
  });
});

describe('withContentDifferences', () => {
  const base = { purchaseOrders: [{ poNumber: 'PO1', differences: [{ field: 'total', existing: 1, requested: 2 }] }], items: [], categories: [] };
  it('adds a PO the tool did not name, and merges the fields of one it did (once per PO, the tool\'s first)', () => {
    const out = withContentDifferences(base, [{ poNumber: 'PO1', differences: [{ field: 'supplier_id', existing: 'a', requested: 'b' }] }, { poNumber: 'PO2', differences: [{ field: 'reference', existing: 'x', requested: 'y' }] }]);
    expect(out.purchaseOrders.map((p) => [p.poNumber, p.differences.map((d) => d.field)])).toEqual([['PO1', ['total', 'supplier_id']], ['PO2', ['reference']]]);
  });
  it('a fact the tool already reported is not listed twice: the same field, or its lines[i].item_id for our "line i+1 item_id"', () => {
    const tool = { purchaseOrders: [{ poNumber: 'PO1', differences: [
      { field: 'po_number', existing: 'PO1', requested: 'PO1-R' }, { field: 'status', existing: 'a', requested: 'b' }, { field: 'lines[0].item_id', existing: null, requested: ITEM },
    ] }], items: [], categories: [] };
    const out = withContentDifferences(tool, [{ poNumber: 'PO1', differences: [
      { field: 'po_number', existing: 'PO1', requested: 'PO1-R' }, { field: 'line 1 item_id', existing: null, requested: ITEM }, { field: 'line 2 item_id', existing: null, requested: ITEM }, { field: 'reference', existing: 'x', requested: 'y' },
    ] }]);
    expect(out.purchaseOrders[0]!.differences.map((d) => d.field)).toEqual(['po_number', 'status', 'lines[0].item_id', 'line 2 item_id', 'reference']);
  });
  it('leaves the report alone when there is nothing to add', () => {
    expect(withContentDifferences(base, [])).toEqual(base);
  });
});

describe('storedPoFrom: the row set the tool writes for its own parse', () => {
  const parsed = {
    poNumber: 'PO1', supplierId: S1, orderDate: '2026-02-01', deliveryDate: null, status: 'approved', reference: null,
    ref: { system: 'sage', ref: '1', documentNumber: 'PO1' }, totals: { subtotal: 275050, tax: 41258, total: 316308 },
    lines: [{ description: 'A', quantity: 2, unitPrice: 90, taxRate: 15, cents: { net: 18000, tax: 2700 } }],
  };
  it('has exactly the compared columns, in rands, with the plan\'s item decision', () => {
    const st = storedPoFrom(parsed, () => ({ itemId: ITEM, itemCode: 'FIB-1' }));
    expect(Object.keys(st.header).sort()).toEqual([...PO_HEADER_COMPARED].sort());
    expect(Object.keys(st.lines[0]!.columns).sort()).toEqual([...PO_LINE_COMPARED].sort());
    expect(st.header).toMatchObject({ subtotal: 2750.5, tax_amount: 412.58, total: 3163.08, expected_delivery_date: null, external_ref: '1', external_document_number: 'PO1' });
    expect(st.lines[0]).toEqual({ itemCode: 'FIB-1', columns: {
      description: 'A', quantity: 2, unit_price: 90, tax_rate: 15, line_total: 180, tax_amount: 27, item_id: ITEM, sort_order: 0,
    } });
  });
});
