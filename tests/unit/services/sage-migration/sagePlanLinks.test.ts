/**
 * PO lines and their items (after #1740: bulk_create_purchase_orders takes item_code on a line and refuses the WHOLE batch for an
 * unknown, inactive or other-company item). The plan sends item_code only for an item it knows is active and sent in this run, or
 * already present, owned by Sage and active; any other line goes without it, keeps the " [item CODE]" suffix, is counted, and cannot
 * cost its batch. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { planMigration } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';
import type { SupplierResolution } from '@/modules/accounting/services/sage-migration/sageSuppliers';

const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
type Row = Record<string, unknown>;
const file = () => JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')) as { Items: { $resources: Row[] }; PurchaseOrders: Row[] };
const NONE = { items: [], categories: [], poNumbers: new Map(), budgetPolicy: 'warn', inactiveSuppliers: new Set<string>() };
const resolved = (): Map<string, SupplierResolution> => new Map([['301', { id: SUPPLIER }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]);
const plan = (f = file(), existing: Record<string, unknown> = NONE) => planMigration(parseSageExport(f), resolved(), existing as never);
type Line = { description: string; item_code?: string };
const lines = (p: ReturnType<typeof plan>, number: string) => (p.purchaseOrders.find((x) => x.documentNumber === number)!.element.lines as Line[]);
// Fixture: PO0000197 names item 50001 (FIB-0001) on line 1 and 50005 (SVC-005) on line 3; PO0000202 names 50001; 201 and 205 name 50005.

describe('a line whose item is sent in this run and active is linked by item_code, with no suffix', () => {
  it('item_code is the item\'s code and the description is the line\'s own', () => {
    const l = lines(plan(), 'PO0000197');
    expect(l[0]).toMatchObject({ description: 'Fibre cable drum (PO 197)', item_code: 'FIB-0001' });
    expect(l[1]).toEqual(expect.not.objectContaining({ item_code: expect.anything() })); // a free-text line
    expect(l[2]).toMatchObject({ description: 'Installation visit', item_code: 'SVC-005' });
  });
  it('the plan counts the linked lines and lists none as not linked', () => {
    const p = plan();
    expect(p.lineLinks.linked).toBe(5); // item 50001 on PO197 and PO202; item 50005 on PO197, PO201 and PO205
    expect(p.lineLinks.notLinked).toEqual([]);
  });
});

describe('a line whose item is inactive goes without item_code and keeps the suffix', () => {
  it('Sage Active false: unlinked, reason inactive, counted and listed; the PO and its other lines are sent', () => {
    const f = file();
    f.Items.$resources[0] = { ...f.Items.$resources[0], Active: false }; // 50001
    const p = plan(f);
    const l = lines(p, 'PO0000197');
    expect(l[0]).toEqual({ description: 'Fibre cable drum (PO 197) [item FIB-0001]', quantity: 2, unit_price: 1200, tax_rate: 15, line_total: 2400, tax_amount: 360 });
    expect(l[0]).not.toHaveProperty('item_code');
    expect(l[2]).toMatchObject({ item_code: 'SVC-005' }); // the other item still links
    expect(p.lineLinks.notLinked).toEqual([
      { poNumber: 'PO0000197', line: 1, itemCode: 'FIB-0001', reason: 'inactive' }, { poNumber: 'PO0000202', line: 1, itemCode: 'FIB-0001', reason: 'inactive' },
    ]);
    expect(p.refusals).toEqual([]);
  });
});

describe('a line whose item is refused goes without item_code and keeps the suffix (it no longer refuses the PO)', () => {
  it('an item the parser refuses: unlinked, reason refused, suffix from its readable code', () => {
    const f = file();
    f.Items.$resources[4] = { ...f.Items.$resources[4], TaxTypeIdSales: 9 }; // 50005 refused
    const p = plan(f);
    expect(lines(p, 'PO0000197')[2]).toMatchObject({ description: 'Installation visit [item SVC-005]' });
    expect(lines(p, 'PO0000197')[2]).not.toHaveProperty('item_code');
    expect(p.refusals.filter((r) => r.entity === 'purchase_order')).toEqual([]);
    expect(p.lineLinks.notLinked.map((x) => [x.poNumber, x.reason])).toEqual([['PO0000197', 'refused'], ['PO0000201', 'refused'], ['PO0000205', 'refused']]);
    expect(p.purchaseOrders).toHaveLength(10);
  });
  it('an item the plan refuses (a code another item holds) is the same: the PO goes, its line unlinked', () => {
    const existing = { ...NONE, items: [{ id: 'x', code: 'FIB-0001', system: null, ref: null, deleted: false, itemType: 'physical', inventoryTracked: false, hasMovements: false, isActive: true }] };
    const p = plan(file(), existing);
    expect(lines(p, 'PO0000197')[0]).toMatchObject({ description: 'Fibre cable drum (PO 197) [item FIB-0001]' });
    expect(lines(p, 'PO0000197')[0]).not.toHaveProperty('item_code');
    expect(p.lineLinks.notLinked.every((x) => x.itemCode === 'FIB-0001' && x.reason === 'refused')).toBe(true);
  });
  it('an item the export does not contain still refuses the PO (line_item_unknown): there is no code to name it by', () => {
    const f = file();
    f.PurchaseOrders[1] = { ...f.PurchaseOrders[1], Lines: [{ ...(f.PurchaseOrders[1]!.Lines as Row[])[0], ItemId: 777777 }] };
    const p = plan(f);
    expect(p.refusals.map((r) => [r.label, r.code])).toEqual([['PO0000198', 'line_item_unknown']]);
  });
});

describe('an owned item that is present but not sent this run', () => {
  const owned = (over: Record<string, unknown>) => ({
    ...NONE, items: [{ id: 'i1', code: 'FIB-0001-IS', system: 'sage', ref: '50001', deleted: false, itemType: 'physical', inventoryTracked: true, hasMovements: true, isActive: true, ...over }],
  });
  it('(it is refused as item_has_stock_movements) active: linked, by ITS stored code', () => {
    const p = plan(file(), owned({}));
    expect(p.refusals.some((r) => r.code === 'item_has_stock_movements')).toBe(true);
    expect(lines(p, 'PO0000197')[0]).toMatchObject({ description: 'Fibre cable drum (PO 197)', item_code: 'FIB-0001-IS' });
  });
  it('inactive: unlinked, reason inactive, suffix with the stored code', () => {
    const p = plan(file(), owned({ isActive: false }));
    expect(lines(p, 'PO0000197')[0]).toMatchObject({ description: 'Fibre cable drum (PO 197) [item FIB-0001-IS]' });
    expect(p.lineLinks.notLinked[0]).toMatchObject({ itemCode: 'FIB-0001-IS', reason: 'inactive' });
  });
  it('a deleted item is not owned: unlinked as refused', () => {
    expect(plan(file(), owned({ deleted: true })).lineLinks.notLinked[0]).toMatchObject({ reason: 'refused' });
  });
  it('an item of ANOTHER system with the same reference is not the migration\'s: its code is held (the Sage item is refused) and the line is unlinked as refused, never linked to it', () => {
    for (const other of [{ system: 'pastel', ref: '50001' }, { system: null, ref: null }, { system: 'Sage', ref: '50001' }]) {
      const p = plan(file(), owned({ ...other, code: 'FIB-0001', hasMovements: false }));
      expect(p.refusals.some((r) => r.label === 'FIB-0001' && r.code === 'code_held_by_existing_item'), JSON.stringify(other)).toBe(true);
      expect(lines(p, 'PO0000197')[0], JSON.stringify(other)).not.toHaveProperty('item_code');
      expect(p.lineLinks.notLinked.find((x) => x.poNumber === 'PO0000197' && x.line === 1), JSON.stringify(other)).toMatchObject({ reason: 'refused' });
    }
  });
});

describe('the suffix and the description limit', () => {
  it('a linked line has no suffix, so a 490-character description is fine; the same line unlinked would pass 500 and refuses its PO', () => {
    const f = file();
    const long = (f.PurchaseOrders[0]!.Lines as Row[]);
    long[0] = { ...long[0], Description: 'x'.repeat(490) };
    expect(plan(f).refusals).toEqual([]);
    f.Items.$resources[0] = { ...f.Items.$resources[0], Active: false }; // now unlinked: 490 + " [item FIB-0001]" = 506
    const r = plan(f).refusals;
    expect(r).toEqual([expect.objectContaining({ label: 'PO0000197', code: 'line_description_too_long' })]);
  });
});
