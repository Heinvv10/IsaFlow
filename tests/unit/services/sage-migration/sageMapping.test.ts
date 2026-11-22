/**
 * Sage -> IsaFlow mapping: item rows for bulk_upsert_items, category args, PO elements for bulk_create_purchase_orders.
 * The mapped rows are also run through the tools' OWN pure validators (validateItemFields, parsePurchaseOrder), so a mapping
 * the tools would refuse fails here, not in a batch.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { mapSageCategory, mapSageItem } from '@/modules/accounting/services/sage-migration/sageItemMapping';
import { mapSagePurchaseOrder, suffixedDescription } from '@/modules/accounting/services/sage-migration/sagePurchaseOrderMapping';
import { importStatusFor, OPEN_SAGE_PO_IMPORTED_AS, statusTableFor } from '@/modules/accounting/services/sage-migration/sagePoStatus';
import { validateItemFields } from '@/modules/accounting/services/items/itemFieldValidation';
import { IMPORT_STATUS_ALIASES, parsePurchaseOrder } from '@/lib/mcp/tools/purchaseOrderImportArgs';

const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const parsed = () => parseSageExport(JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')));
const byCode = (code: string) => parsed().items.find((i) => i.code === code)!;

describe('item mapping', () => {
  it('every fixture item maps to a row the item tool accepts', () => {
    for (const i of parsed().items) expect(validateItemFields(mapSageItem(i)), i.code).toMatchObject({ ok: true });
  });

  it('a Sage service code imports as a service, never tracked; a physical item as physical, never tracked', () => {
    const svc = mapSageItem(byCode('SVC-005'));
    expect(svc).toMatchObject({ item_type: 'service', inventory_tracked: false });
    const phys = mapSageItem(byCode('FIB-0001'));
    expect(phys).toMatchObject({ item_type: 'physical', inventory_tracked: false });
    expect(parsed().items.every((i) => mapSageItem(i).inventory_tracked === false)).toBe(true);
  });

  it('carries the Sage id as the external reference and the fields as documented', () => {
    expect(mapSageItem(byCode('FIB-0001'))).toEqual({
      code: 'FIB-0001', description: 'Fibre stock item 1', item_type: 'physical', inventory_tracked: false, is_active: true,
      external_system: 'sage', external_ref: '50001', category_name: 'Optics', sales_price: 107.5, purchase_price: 63.25,
      vat_on_sales: 'standard', vat_on_purchases: 'standard',
    });
  });

  it('inactive stays inactive; zero and exempt VAT map; no category and no category_name', () => {
    expect(mapSageItem(byCode('FIB-0007')).is_active).toBe(false);
    expect(mapSageItem(byCode('FIB-0009')).vat_on_sales).toBe('zero');
    expect(mapSageItem(byCode('FIB-0011')).vat_on_purchases).toBe('exempt');
    expect(mapSageItem(byCode('FIB-0013'))).not.toHaveProperty('category_name');
  });

  it('cost: LastCost when above 0, else AverageCost rounded to cents; none when neither exists', () => {
    const base = byCode('FIB-0001');
    expect(mapSageItem({ ...base, lastCost: 0, averageCost: 12.34 }).purchase_price).toBe(12.34);
    expect(mapSageItem({ ...base, lastCost: null, averageCost: 9.5 }).purchase_price).toBe(9.5);
    expect(mapSageItem({ ...base, lastCost: null, averageCost: null })).not.toHaveProperty('purchase_price');
  });

  it('HARD RULE: no mapped item row names a quantity, stock or opening field, and no QuantityOnHand VALUE appears anywhere', () => {
    for (const i of parsed().items) {
      expect(Object.keys(mapSageItem(i)).filter((k) => /quant|stock|opening|qty|on_hand/i.test(k))).toEqual([]);
    }
    // Give every item a quantity no price, cost or code can equal, then look for it in everything the migration produces.
    const file = JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
    const sentinels = file.Items.$resources.map((r: Record<string, unknown>, n: number) => { r.QuantityOnHand = 7770000 + n + 0.123; return String(7770000 + n); });
    const p = parseSageExport(file);
    expect(p.items).toHaveLength(20);
    const everything = JSON.stringify([p.items, p.categories, p.items.map(mapSageItem), p.purchaseOrders]);
    for (const s of sentinels) expect(everything, s).not.toContain(s);
    expect(p.itemsWithQuantityOnHand).toBe(20);
  });

  it('a category maps to its name, the Sage id as reference, active', () => {
    expect(mapSageCategory({ id: '10', description: 'Optics' })).toEqual({ name: 'Optics', external_system: 'sage', external_ref: '10', is_active: true });
  });
});

describe('purchase order status', () => {
  it('Pending and Overdue are open, Invoiced is billed (closed), Cancelled is cancelled; case does not matter; others are null', () => {
    expect([importStatusFor('Pending'), importStatusFor('overdue'), importStatusFor('INVOICED'), importStatusFor('Cancelled')]).toEqual(['open', 'open', 'billed', 'cancelled']);
    expect([importStatusFor('Draft'), importStatusFor(''), importStatusFor('toString')]).toEqual([null, null, null]);
  });
});

describe('F7e: how a Pending or Overdue Sage PO is imported is one decision', () => {
  it('Pending and Overdue both take the one constant (open today); Invoiced and Cancelled do not', () => {
    expect(OPEN_SAGE_PO_IMPORTED_AS).toBe('open');
    expect(['draft', 'open']).toContain(OPEN_SAGE_PO_IMPORTED_AS);
    expect(importStatusFor('Pending')).toBe(OPEN_SAGE_PO_IMPORTED_AS);
    expect(importStatusFor('Overdue')).toBe(OPEN_SAGE_PO_IMPORTED_AS);
    expect(importStatusFor('Invoiced')).toBe('billed');
    expect(importStatusFor('Cancelled')).toBe('cancelled');
  });
  it('choosing draft moves exactly Pending and Overdue to draft and nothing else', () => {
    expect(statusTableFor('draft')).toEqual({ pending: 'draft', overdue: 'draft', invoiced: 'billed', cancelled: 'cancelled' });
    expect(statusTableFor('open')).toEqual({ pending: 'open', overdue: 'open', invoiced: 'billed', cancelled: 'cancelled' });
  });
  it('the words it can be set to are ones the PO tool accepts', () => {
    for (const w of ['draft', 'open']) expect(Object.keys(IMPORT_STATUS_ALIASES)).toContain(w);
  });
});

describe('purchase order mapping', () => {
  const p = parsed();
  const links = (link: boolean) => Object.fromEntries(Object.entries(p.itemCodes).map(([id, code]) => [id, { code, link }]));
  const map = (n: number, link = true) => mapSagePurchaseOrder(p.purchaseOrders[n]!, SUPPLIER, links(link));

  it('every fixture PO maps to an element the PO tool\'s own parser accepts, with the totals it was sent', () => {
    p.purchaseOrders.forEach((po, n) => {
      const parsedPo = parsePurchaseOrder(map(n), n);
      expect(typeof parsedPo === 'string' ? parsedPo : 'ok', po.documentNumber).toBe('ok');
      if (typeof parsedPo !== 'string') expect(parsedPo.totals.total).toBe(Math.round(po.total * 100));
    });
  });

  it('keeps the number, the Sage id as the reference, the dates, the reference and the supplier', () => {
    expect(map(0)).toMatchObject({
      po_number: 'PO0000197', external_system: 'sage', external_ref: '900197', external_document_number: 'PO0000197',
      supplier_id: SUPPLIER, order_date: '2026-01-10', delivery_date: '2026-01-25', reference: 'JOB-400', status: 'open',
    });
    expect(map(1)).not.toHaveProperty('delivery_date');
  });

  it('maps every status across the fixture: Pending/Overdue open, Invoiced billed, Cancelled cancelled', () => {
    expect(p.purchaseOrders.map((po, n) => [po.status, map(n).status])).toEqual([
      ['Pending', 'open'], ['Pending', 'open'], ['Pending', 'open'], ['Overdue', 'open'], ['Overdue', 'open'],
      ['Invoiced', 'billed'], ['Invoiced', 'billed'], ['Invoiced', 'billed'], ['Cancelled', 'cancelled'], ['Cancelled', 'cancelled'],
    ]);
  });

  it('keeps the Sage status and comments in the notes', () => {
    expect(map(3).notes).toBe('Sage status: Overdue\nUrgent: chase supplier');
    expect(map(0).notes).toBe('Sage status: Pending');
  });

  it('a LINKED line names its item by item_code and keeps its own description; a free-text line has neither', () => {
    const lines = map(0).lines as Array<{ description: string; item_code?: string }>;
    expect(lines[0]).toMatchObject({ description: 'Fibre cable drum (PO 197)', item_code: 'FIB-0001' });
    expect(lines[1]).toMatchObject({ description: 'Delivery charge' });
    expect(lines[1]).not.toHaveProperty('item_code');
    expect(lines[2]).toMatchObject({ description: 'Installation visit', item_code: 'SVC-005' });
  });

  it('an UNLINKED line carries its item\'s code in the description and no item_code', () => {
    const lines = map(0, false).lines as Array<{ description: string; item_code?: string }>;
    expect(lines[0]!.description).toBe('Fibre cable drum (PO 197) [item FIB-0001]');
    expect(lines[0]).not.toHaveProperty('item_code');
    expect(lines[1]!.description).toBe('Delivery charge');
    expect(lines[2]!.description).toBe('Installation visit [item SVC-005]');
  });

  it('F7b: an unlinked description that no longer fits with the item suffix is an error, never a silent cut', () => {
    const po = { ...p.purchaseOrders[0]!, lines: [{ ...p.purchaseOrders[0]!.lines[0]!, description: 'x'.repeat(500) }] };
    expect(() => mapSagePurchaseOrder(po, SUPPLIER, links(false))).toThrow(/516 characters/);
    expect(() => suffixedDescription('x'.repeat(500 - ' [item FIB-0001]'.length), 'FIB-0001')).not.toThrow();
    expect(suffixedDescription('x'.repeat(500 - ' [item FIB-0001]'.length), 'FIB-0001')).toHaveLength(500);
    // Linked, the same 500-character description needs no suffix and passes.
    expect((mapSagePurchaseOrder(po, SUPPLIER, links(true)).lines as Array<{ description: string }>)[0]!.description).toHaveLength(500);
  });

  it('sends the source\'s own line figures and header totals', () => {
    const lines = map(0).lines as Array<Record<string, number>>;
    expect(lines[0]).toMatchObject({ quantity: 2, unit_price: 1200, tax_rate: 15, line_total: 2400, tax_amount: 360 });
    expect(map(0).expected_totals).toEqual({ subtotal: 4115, tax_amount: 617.25, total: 4732.25 });
  });

  it('refuses to map a status it has no word for (the parser never lets one through)', () => {
    expect(() => mapSagePurchaseOrder({ ...p.purchaseOrders[0]!, status: 'Draft' }, SUPPLIER, {})).toThrow(/no mapping/);
  });
});
