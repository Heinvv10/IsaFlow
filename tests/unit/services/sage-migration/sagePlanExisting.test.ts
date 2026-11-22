/**
 * The plan against what the company already holds, split from sagePlan.test.ts: item codes, PO numbers, categories.
 * Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { planMigration } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';
import type { SupplierResolution } from '@/modules/accounting/services/sage-migration/sageSuppliers';

const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const parsed = () => parseSageExport(JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')));
const NONE = { items: [], categories: [], poNumbers: new Map() };
const allResolved = (): Map<string, SupplierResolution> => new Map([['301', { id: SUPPLIER }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]);

describe('rows the company\'s own data would make a tool refuse are refused here, one reason per row', () => {
  const held = (over: Partial<{ id: string; code: string; system: string | null; ref: string | null; deleted: boolean }>) =>
    ({ items: [{ id: 'i1', code: 'X', system: null, ref: null, deleted: false, ...over }], categories: [], poNumbers: new Map() });
  const refusalFor = (existing: ReturnType<typeof held>, label = 'FIB-0001') => planMigration(parsed(), allResolved(), existing).refusals.find((r) => r.label === label);

  it('F1: a code an existing item holds that this migration does not own is refused, naming that item, whatever the item\'s reference', () => {
    for (const other of [{ system: 'sage', ref: '12345' }, { system: 'pastel', ref: '50001' }, { system: null, ref: null }]) {
      const r = refusalFor(held({ code: 'FIB-0001', ...other }));
      expect(r, JSON.stringify(other)).toMatchObject({ entity: 'item', code: 'code_held_by_existing_item' });
      expect(r!.reasons[0]).toMatch(/item FIB-0001 \(id i1, /);
      expect(r!.reasons[0]).toMatch(other.ref ? new RegExp(`${other.system} ${other.ref}`) : /no external reference/);
      expect(r!.reasons[0]).toMatch(/never updated/);
    }
  });
  it('F1: the item is never sent, so no row can touch it; the other 19 items are sent', () => {
    const plan = planMigration(parsed(), allResolved(), held({ code: 'FIB-0001' }));
    expect(plan.items.map((i) => i.sageId)).not.toContain('50001');
    expect(plan.items).toHaveLength(19);
  });
  it('the Sage id on one item and the code on another: ref_code_conflict', () => {
    const existing = { items: [
      { id: 'a', code: 'OLD', system: 'sage', ref: '50001', deleted: false }, { id: 'b', code: 'FIB-0001', system: null, ref: null, deleted: false },
    ], categories: [], poNumbers: new Map() };
    expect(refusalFor(existing)).toMatchObject({ code: 'ref_code_conflict' });
  });
  it('the SAME item (this Sage id, this code) is the migration\'s own: sent as an update', () => {
    expect(refusalFor(held({ code: 'FIB-0001', system: 'sage', ref: '50001' }))).toBeUndefined();
  });
  it('an item of the migration that was deleted: item_deleted; a deleted item of someone else holding the code: held', () => {
    expect(refusalFor(held({ code: 'FIB-0001', system: 'sage', ref: '50001', deleted: true }))).toMatchObject({ code: 'item_deleted' });
    expect(refusalFor(held({ code: 'FIB-0001', deleted: true }))).toMatchObject({ code: 'code_held_by_existing_item' });
  });
  it('code uniqueness is case-sensitive (the index is on the plain column), so a code differing in case is no conflict', () => {
    expect(refusalFor(held({ code: 'fib-0001', system: 'sage', ref: '12345' }))).toBeUndefined();
  });
  it('a PO number another purchase order holds: po_number_taken; the same Sage PO again is sent (the tool replays it)', () => {
    const none = (system: string | null, ref: string | null) => ({ items: [], categories: [], poNumbers: new Map([['PO0000197', { system, ref }]]) });
    expect(planMigration(parsed(), allResolved(), none(null, null)).refusals.find((r) => r.label === 'PO0000197')).toMatchObject({ entity: 'purchase_order', code: 'po_number_taken' });
    expect(planMigration(parsed(), allResolved(), none('sage', '555')).refusals.find((r) => r.label === 'PO0000197')).toMatchObject({ code: 'po_number_taken' });
    expect(planMigration(parsed(), allResolved(), none('sage', '900197')).refusals).toEqual([]);
    expect(planMigration(parsed(), allResolved(), none('pastel', '900197')).refusals).toHaveLength(1);
  });
  it('F7b: a line whose description plus the item suffix passes 500 characters refuses its PO; nothing is cut', () => {
    const p = parsed();
    const long = 'x'.repeat(490); // " [item FIB-0001]" makes 506
    const po0 = { ...p.purchaseOrders[0]!, lines: [{ ...p.purchaseOrders[0]!.lines[0]!, description: long }, ...p.purchaseOrders[0]!.lines.slice(1)] };
    const plan = planMigration({ ...p, purchaseOrders: [po0, ...p.purchaseOrders.slice(1)] }, allResolved(), NONE);
    const r = plan.refusals.find((x) => x.label === 'PO0000197')!;
    expect(r).toMatchObject({ entity: 'purchase_order', code: 'line_description_too_long' });
    expect(r.reasons[0]).toMatch(/line 1: .*506 characters.*500/);
    expect(plan.purchaseOrders.map((x) => x.documentNumber)).not.toContain('PO0000197');
    // Exactly 500 with its suffix is fine, and a line with no item may be 500 long on its own.
    const fits = { ...po0, lines: [{ ...po0.lines[0]!, description: 'x'.repeat(500 - ' [item FIB-0001]'.length) }, ...po0.lines.slice(1)] };
    expect(planMigration({ ...p, purchaseOrders: [fits] }, allResolved(), NONE).refusals).toEqual([]);
  });
  it('a refused item takes the POs that name it with it (line_item_refused), and the others are untouched', () => {
    const plan = planMigration(parsed(), allResolved(), held({ code: 'FIB-0001', system: 'sage', ref: '12345' }));
    expect(plan.items.map((i) => i.sageId)).not.toContain('50001');
    const poRefused = plan.refusals.filter((r) => r.entity === 'purchase_order');
    expect(poRefused.map((r) => [r.label, r.code]).sort()).toEqual([['PO0000197', 'line_item_refused'], ['PO0000202', 'line_item_refused']]);
    expect(plan.purchaseOrders).toHaveLength(8);
  });
  it('an item the tool\'s validator refuses takes its POs too, and a PO line carries only a SENT item\'s code', () => {
    const p = parsed();
    const bad = { ...p, items: p.items.map((i) => (i.id === '50005' ? { ...i, code: '' } : i)) };
    const plan = planMigration(bad, allResolved(), NONE);
    expect(plan.refusals.filter((r) => r.entity === 'purchase_order').map((r) => r.code)).toEqual(['line_item_refused', 'line_item_refused', 'line_item_refused']);
    const sent = JSON.stringify(plan.purchaseOrders.map((x) => x.element));
    expect(sent).not.toContain('[item SVC-005]');
    expect(sent).toContain('[item FIB-0001]');
  });
});

describe('a category name an IsaFlow category the migration does not own holds', () => {
  const cats = (...c: Array<{ id: string; name: string; system: string | null; ref: string | null }>) => ({ items: [], categories: c, poNumbers: new Map() });
  const plan = (existing: ReturnType<typeof cats>) => planMigration(parsed(), allResolved(), existing);

  it('the category row is refused category_name_in_use naming the holder; the category is not sent', () => {
    const p = plan(cats({ id: 'c1', name: 'optics', system: null, ref: null }));
    const r = p.refusals.find((x) => x.entity === 'category')!;
    expect(r).toMatchObject({ entity: 'category', sageId: '10', label: 'Optics', code: 'category_name_in_use' });
    expect(r.reasons[0]).toMatch(/category optics \(id c1, no external reference\)/);
    expect(p.categories.map((c) => c.name)).toEqual(['Poles and Hardware', 'Services', 'Tools']);
  });
  it('the items in that category are refused category_refused, naming it; items of other categories and of none are sent', () => {
    const p = plan(cats({ id: 'c1', name: 'Optics', system: 'pastel', ref: '9' }));
    const items = p.refusals.filter((x) => x.entity === 'item');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((x) => x.code === 'category_refused' && /Optics/.test(x.reasons[0]!))).toBe(true);
    const optics = parsed().items.filter((i) => i.category?.description === 'Optics').map((i) => i.id);
    expect(items.map((x) => x.sageId).sort()).toEqual([...optics].sort());
    expect(p.items.map((i) => i.sageId)).toHaveLength(20 - optics.length);
    expect(p.items.map((i) => i.sageId)).toContain('50013'); // FIB-0013 has no category
  });
  it('the POs naming a refused item follow it (line_item_refused), the rest are sent', () => {
    const p = plan(cats({ id: 'c1', name: 'Optics', system: null, ref: null }));
    expect(p.refusals.filter((x) => x.entity === 'purchase_order').every((x) => x.code === 'line_item_refused')).toBe(true);
    expect(p.refusals.filter((x) => x.entity === 'purchase_order').length).toBeGreaterThan(0);
  });
  it('the migration\'s OWN category (this Sage id) is no conflict, even under another name (the tool renames it)', () => {
    expect(plan(cats({ id: 'c1', name: 'Optics', system: 'sage', ref: '10' })).refusals).toEqual([]);
    expect(plan(cats({ id: 'c1', name: 'Old name', system: 'sage', ref: '10' })).refusals).toEqual([]);
  });
  it('a different Sage category holding the name is not the migration\'s own for THIS id: refused', () => {
    expect(plan(cats({ id: 'c1', name: 'Optics', system: 'sage', ref: '99' })).refusals.find((x) => x.entity === 'category')).toMatchObject({ code: 'category_name_in_use' });
  });
  it('names compare case-insensitively (the tool does), and an unrelated name is no conflict', () => {
    expect(plan(cats({ id: 'c1', name: 'OPTICS', system: null, ref: null })).refusals.some((x) => x.entity === 'category')).toBe(true);
    expect(plan(cats({ id: 'c1', name: 'Optics and more', system: null, ref: null })).refusals).toEqual([]);
  });
});
