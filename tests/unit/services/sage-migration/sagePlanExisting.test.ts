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
const NONE = { items: [], categories: [], poNumbers: new Map(), budgetPolicy: 'warn', inactiveSuppliers: new Set<string>() };
const allResolved = (): Map<string, SupplierResolution> => new Map([['301', { id: SUPPLIER }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]);

describe('rows the company\'s own data would make a tool refuse are refused here, one reason per row', () => {
  const held = (over: Partial<{ id: string; code: string; system: string | null; ref: string | null; deleted: boolean }>) =>
    ({ items: [{ id: 'i1', code: 'X', system: null, ref: null, deleted: false, ...over }], categories: [], poNumbers: new Map(), inactiveSuppliers: new Set<string>() });
  const refusalFor = (existing: ReturnType<typeof held>, label = 'FIB-0001') => planMigration(parsed(), allResolved(), existing).refusals.find((r) => r.label === label);

  it('F1: a code an existing item holds that this migration does not own is refused, naming that item, whatever the item\'s reference', () => {
    for (const other of [{ system: 'sage', ref: '12345' }, { system: 'pastel', ref: '50001' }, { system: null, ref: null }]) {
      const r = refusalFor(held({ code: 'FIB-0001', ...other }));
      expect(r, JSON.stringify(other)).toMatchObject({ entity: 'item', code: 'code_held_by_existing_item' });
      expect(r!.reasons[0]).toMatch(/item FIB-0001 \(id i1, /);
      expect(r!.reasons[0]).toMatch(other.ref ? new RegExp(`${other.system} ${other.ref}`) : /no external reference/);
      expect(r!.reasons[0]).toMatch(other.system === 'sage' ? /under a different Sage id/ : /never updated/);
    }
  });
  it('L8: a code held by another SAGE item (a different Sage id) says so; one never imported says the migration does not own it', () => {
    const sageOther = refusalFor(held({ code: 'FIB-0001', system: 'sage', ref: '12345' }))!;
    expect(sageOther.reasons[0]).toMatch(/held by item FIB-0001 \(id i1, sage 12345\), under a different Sage id/);
    expect(sageOther.reasons[0]).not.toMatch(/does not own/);
    const foreign = refusalFor(held({ code: 'FIB-0001', system: 'pastel', ref: '9' }))!;
    expect(foreign.reasons[0]).toMatch(/which this migration does not own/);
    expect(refusalFor(held({ code: 'FIB-0001' }))!.reasons[0]).toMatch(/which this migration does not own/);
  });
  it('F1: the item is never sent, so no row can touch it; the other 19 items are sent', () => {
    const plan = planMigration(parsed(), allResolved(), held({ code: 'FIB-0001' }));
    expect(plan.items.map((i) => i.sageId)).not.toContain('50001');
    expect(plan.items).toHaveLength(19);
  });
  it('the Sage id on one item and the code on another: ref_code_conflict', () => {
    const existing = { items: [
      { id: 'a', code: 'OLD', system: 'sage', ref: '50001', deleted: false }, { id: 'b', code: 'FIB-0001', system: null, ref: null, deleted: false },
    ], categories: [], poNumbers: new Map(), inactiveSuppliers: new Set<string>() };
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
    const none = (system: string | null, ref: string | null) => ({ items: [], categories: [], poNumbers: new Map([['PO0000197', { system, ref }]]), inactiveSuppliers: new Set<string>() });
    expect(planMigration(parsed(), allResolved(), none(null, null)).refusals.find((r) => r.label === 'PO0000197')).toMatchObject({ entity: 'purchase_order', code: 'po_number_taken' });
    expect(planMigration(parsed(), allResolved(), none('sage', '555')).refusals.find((r) => r.label === 'PO0000197')).toMatchObject({ code: 'po_number_taken' });
    expect(planMigration(parsed(), allResolved(), none('sage', '900197')).refusals).toEqual([]);
    expect(planMigration(parsed(), allResolved(), none('pastel', '900197')).refusals).toHaveLength(1);
  });
  it('a refused item no longer takes the POs that name it: they are sent, the line goes unlinked with its suffix (sagePlanLinks.test.ts)', () => {
    const plan = planMigration(parsed(), allResolved(), held({ code: 'FIB-0001', system: 'sage', ref: '12345' }));
    expect(plan.items.map((i) => i.sageId)).not.toContain('50001');
    expect(plan.refusals.filter((r) => r.entity === 'purchase_order')).toEqual([]);
    expect(plan.purchaseOrders).toHaveLength(10);
    expect(plan.lineLinks.notLinked.map((x) => [x.poNumber, x.itemCode, x.reason])).toEqual([['PO0000197', 'FIB-0001', 'refused'], ['PO0000202', 'FIB-0001', 'refused']]);
  });
});

describe('a category name an IsaFlow category the migration does not own holds', () => {
  const cats = (...c: Array<{ id: string; name: string; system: string | null; ref: string | null }>) => ({ items: [], categories: c, poNumbers: new Map(), inactiveSuppliers: new Set<string>() });
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
  it('the POs naming an item of that category are sent, those lines unlinked as refused', () => {
    const p = plan(cats({ id: 'c1', name: 'Optics', system: null, ref: null }));
    expect(p.refusals.filter((x) => x.entity === 'purchase_order')).toEqual([]);
    expect(p.lineLinks.notLinked.length).toBeGreaterThan(0);
    expect(p.lineLinks.notLinked.every((x) => x.reason === 'refused')).toBe(true);
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

describe('M1: an approved PO with no GL account under the block policy is refused per row', () => {
  const under = (policy: string) => ({ items: [], categories: [], poNumbers: new Map(), budgetPolicy: policy, inactiveSuppliers: new Set<string>() });
  const open = () => parsed().purchaseOrders.filter((p) => p.status === 'Pending' || p.status === 'Overdue').map((p) => p.documentNumber);
  const refused = (policy: string, opts = {}) => planMigration(parsed(), allResolved(), under(policy), opts).refusals.filter((r) => r.code === 'accountless_under_block_policy');

  it('block: every open (approved) PO is refused, naming the three remedies; closed and cancelled POs are not', () => {
    const r = refused('block');
    expect(r.map((x) => x.label).sort()).toEqual(open().sort());
    expect(r[0]).toMatchObject({ entity: 'purchase_order' });
    expect(r[0]!.reasons[0]).toMatch(/--skip-budget-check/);
    expect(r[0]!.reasons[0]).toMatch(/--po-gl-account/);
    expect(r[0]!.reasons[0]).toMatch(/OPEN_SAGE_PO_IMPORTED_AS|draft/);
    const plan = planMigration(parsed(), allResolved(), under('block'));
    expect(plan.purchaseOrders.map((p) => p.element.status).sort()).toEqual(['billed', 'billed', 'billed', 'cancelled', 'cancelled']);
  });
  it('warn and off (and no policy read): nothing is refused', () => {
    expect(refused('warn')).toEqual([]);
    expect(refused('off')).toEqual([]);
    expect(planMigration(parsed(), allResolved(), NONE).refusals).toEqual([]);
  });
  it('block with an account for every line, or with the budget check skipped: nothing is refused', () => {
    expect(refused('block', { poGlAccountId: '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f7' })).toEqual([]);
    expect(refused('block', { skipBudgetCheck: true })).toEqual([]);
  });
});

describe('#11: an owned item with stock movements is not flipped to another type or to untracked', () => {
  const own = (over: Record<string, unknown>) => ({
    items: [{ id: 'i1', code: 'FIB-0001', system: 'sage', ref: '50001', deleted: false, itemType: 'physical', inventoryTracked: true, hasMovements: true, ...over }],
    categories: [], poNumbers: new Map(), budgetPolicy: 'warn', inactiveSuppliers: new Set<string>(),
  });
  const refusal = (existing: ReturnType<typeof own>, mutate?: (p: ReturnType<typeof parsed>) => void) => {
    const p = parsed();
    mutate?.(p);
    return planMigration(p, allResolved(), existing).refusals.find((r) => r.label === 'FIB-0001');
  };
  it('tracked with movements, and the export always sends untracked: refused item_has_stock_movements, naming it', () => {
    const r = refusal(own({}));
    expect(r).toMatchObject({ entity: 'item', code: 'item_has_stock_movements' });
    expect(r!.reasons[0]).toMatch(/item FIB-0001 \(id i1\) has stock movements and is physical, tracked.*untracked/);
  });
  it('an untracked physical item with movements that stays physical is fine; so is a tracked item with none', () => {
    expect(refusal(own({ inventoryTracked: false }))).toBeUndefined();
    expect(refusal(own({ hasMovements: false }))).toBeUndefined();
  });
  it('a type flip (physical to a Sage service) on an item with movements is refused, flip or not tracked', () => {
    const toService = (p: ReturnType<typeof parsed>) => { p.items.find((i) => i.id === '50001')!.physical = false; };
    expect(refusal(own({ inventoryTracked: false }), toService)).toMatchObject({ code: 'item_has_stock_movements' });
    expect(refusal(own({ inventoryTracked: false, hasMovements: false }), toService)).toBeUndefined();
  });
  it('an item the migration does not own is still refused as held, not as has-movements', () => {
    expect(refusal(own({ system: null, ref: null }))).toMatchObject({ code: 'code_held_by_existing_item' });
  });
});

const A = '1b7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const B = '2c7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
describe('a PO of an inactive supplier is refused supplier_inactive', () => {
  it('only that supplier\'s POs; the others are sent', () => {
    const existing = { items: [], categories: [], poNumbers: new Map(), budgetPolicy: 'warn', inactiveSuppliers: new Set([B]) };
    const resolved = new Map<string, SupplierResolution>([['301', { id: A }], ['302', { id: B }], ['303', { id: A }]]);
    const plan = planMigration(parsed(), resolved, existing);
    const refused = plan.refusals.filter((r) => r.code === 'supplier_inactive');
    expect(refused.map((r) => r.label).sort()).toEqual(['PO0000198', 'PO0000201', 'PO0000204']);
    expect(refused[0]!.reasons[0]).toMatch(/inactive/);
    expect(plan.purchaseOrders).toHaveLength(7);
  });
});

describe('M1 (round 6): a PO already booked by this migration is not refused for what changed since', () => {
  const booked = { system: 'sage', ref: '900197' }; // PO0000197 is Sage id 900197
  const planWith = (over: Record<string, unknown>) => planMigration(parsed(), allResolved(), { ...NONE, ...over });
  const refusalsOf = (plan: ReturnType<typeof planMigration>) => plan.refusals.filter((r) => r.label === 'PO0000197').map((r) => r.code);

  it('its supplier deactivated since: a new PO to that supplier is refused, the booked one is sent (the tool replays it)', () => {
    const inactive = new Set([SUPPLIER]);
    const fresh = planWith({ inactiveSuppliers: inactive });
    expect(refusalsOf(fresh)).toEqual(['supplier_inactive']);
    const rerun = planWith({ inactiveSuppliers: inactive, poNumbers: new Map([['PO0000197', booked]]) });
    expect(refusalsOf(rerun)).toEqual([]);
    expect(rerun.purchaseOrders.map((p) => p.documentNumber)).toContain('PO0000197');
    // the other POs of that supplier are still refused
    expect(rerun.refusals.filter((r) => r.code === 'supplier_inactive').length).toBeGreaterThan(0);
  });
  it('the budget policy block since: an account-less approved PO is refused when new, sent when already booked', () => {
    const fresh = planWith({ budgetPolicy: 'block' });
    expect(refusalsOf(fresh)).toEqual(['accountless_under_block_policy']);
    const rerun = planWith({ budgetPolicy: 'block', poNumbers: new Map([['PO0000197', booked]]) });
    expect(refusalsOf(rerun)).toEqual([]);
  });
  it('a PO number held by something else is still refused (the exemption is for this migration\'s own PO only)', () => {
    expect(refusalsOf(planWith({ inactiveSuppliers: new Set([SUPPLIER]), poNumbers: new Map([['PO0000197', { system: 'sage', ref: '555' }]]) }))).toEqual(['supplier_inactive']);
  });
});

describe('M2 (round 7): a booked PO is not refused for its supplier on a re-run, and the supplier problem is listed', () => {
  const booked = { system: 'sage', ref: '900197' };
  const BOOKED_SUPPLIER = '9a7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f0';
  const content = new Map([['900197', { header: { po_number: 'PO0000197', supplier_id: BOOKED_SUPPLIER }, lines: [], supplierName: 'Alpha Renamed' }]]);
  const existing = { ...NONE, poNumbers: new Map([['PO0000197', booked]]), poContent: content } as never;
  const unresolved = (): Map<string, SupplierResolution> => new Map([
    ['301', { code: 'supplier_unresolved', reason: 'no IsaFlow supplier carries Sage reference 301 or is named "Alpha Optics (Pty) Ltd"' }],
    ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }],
  ]);
  const po197 = (plan: ReturnType<typeof planMigration>) => plan.purchaseOrders.find((p) => p.documentNumber === 'PO0000197');

  it('every supplier refusal still refuses a NEW PO', () => {
    const fresh = planMigration(parsed(), unresolved(), NONE);
    expect(fresh.refusals.filter((r) => r.label === 'PO0000197').map((r) => r.code)).toEqual(['supplier_unresolved']);
  });
  it('an already-booked PO whose supplier no longer resolves is sent (the tool replays it) under its booked supplier, with the problem recorded', () => {
    const plan = planMigration(parsed(), unresolved(), existing);
    expect(plan.refusals.filter((r) => r.label === 'PO0000197')).toEqual([]);
    const p = po197(plan)!;
    expect(p.element.supplier_id).toBe(BOOKED_SUPPLIER);
    expect(p.supplierProblem).toMatch(/Sage supplier 301.*Alpha Optics \(Pty\) Ltd.*not found in IsaFlow.*booked to.*Alpha Renamed.*9a7d6a3e/s);
  });
  it('the other refusals of the supplier (ambiguous, ref conflict, collapsed, not looked up) are the same: sent, recorded', () => {
    for (const code of ['supplier_ambiguous', 'supplier_ref_conflict', 'supplier_collapsed'] as const) {
      const plan = planMigration(parsed(), new Map([['301', { code, reason: 'x' }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]), existing);
      expect(plan.refusals.filter((r) => r.label === 'PO0000197'), code).toEqual([]);
      expect(po197(plan)!.supplierProblem, code).toMatch(/not found in IsaFlow|cannot be resolved/);
    }
    const notLooked = planMigration(parsed(), new Map([['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]), existing);
    expect(notLooked.refusals.filter((r) => r.label === 'PO0000197')).toEqual([]);
  });
  it('but one booked to a DELETED supplier cannot be replayed by the tool (Not found for the whole batch): refused, with the remedy', () => {
    const gone = { ...existing, poContent: new Map([['900197', { ...content.get('900197')!, supplierDeleted: true }]]) } as never;
    const plan = planMigration(parsed(), unresolved(), gone);
    const r = plan.refusals.filter((x) => x.label === 'PO0000197');
    expect(r.map((x) => x.code)).toEqual(['booked_supplier_deleted']);
    expect(r[0]!.reasons[0]).toMatch(/deleted in IsaFlow.*Restore that supplier/);
    expect(planMigration(parsed(), allResolved(), gone).refusals).toEqual([]); // a resolving supplier needs none of this
  });
  it('B7-A (round 7): "booked" is decided by the Sage REFERENCE, as the tool replays: a booked PO renumbered in Sage is still sent (its number is a difference)', () => {
    // in the books as PO0000197-OLD with Sage ref 900197; Sage now calls it PO0000197
    const renumbered = { ...NONE, poNumbers: new Map([['PO0000197-OLD', { system: 'sage', ref: '900197' }]]), poContent: content } as never;
    const plan = planMigration(parsed(), unresolved(), renumbered);
    expect(plan.refusals.filter((x) => x.label === 'PO0000197')).toEqual([]);
    expect(po197(plan)!.supplierProblem).toBeDefined();
    // the number is free: still sent when the supplier resolves
    expect(planMigration(parsed(), allResolved(), renumbered).refusals).toEqual([]);
  });
  it('B7-A2 (round 7): two booked POs whose numbers Sage swapped are not po_number_taken (the tool replays both by reference)', () => {
    const swapped = { ...NONE, poNumbers: new Map([['PO0000197', { system: 'sage', ref: '900198' }], ['PO0000198', { system: 'sage', ref: '900197' }]]),
      poContent: new Map([['900197', { header: { po_number: 'PO0000198', supplier_id: SUPPLIER }, lines: [] }], ['900198', { header: { po_number: 'PO0000197', supplier_id: SUPPLIER }, lines: [] }]]) } as never;
    expect(planMigration(parsed(), allResolved(), swapped).refusals.filter((r) => r.code === 'po_number_taken')).toEqual([]);
    // without the reference being booked, the number held by another PO is still po_number_taken
    const other = { ...NONE, poNumbers: new Map([['PO0000197', { system: 'sage', ref: '555' }]]) } as never;
    expect(planMigration(parsed(), allResolved(), other).refusals.filter((r) => r.label === 'PO0000197').map((r) => r.code)).toEqual(['po_number_taken']);
  });
  it('a resolved supplier is used as before (the comparison with the books shows a real move)', () => {
    const plan = planMigration(parsed(), allResolved(), existing);
    expect(po197(plan)!.element.supplier_id).toBe(SUPPLIER);
    expect(po197(plan)!.supplierProblem).toBeUndefined();
  });
  it('without the booked supplier in the books\' content the PO is still refused (nothing to send it under)', () => {
    const plan = planMigration(parsed(), unresolved(), { ...NONE, poNumbers: new Map([['PO0000197', booked]]) } as never);
    expect(plan.refusals.filter((r) => r.label === 'PO0000197').map((r) => r.code)).toEqual(['supplier_unresolved']);
  });
});

describe('L5 (round 7): a Sage PO reference held by more than one IsaFlow PO is refused, not picked at random', () => {
  it('refuses the PO naming the numbers that hold it', () => {
    const plan = planMigration(parsed(), allResolved(), { ...NONE, duplicatePoRefs: new Map([['900197', ['PO0000197', 'DUP-1']]]) } as never);
    const r = plan.refusals.filter((x) => x.label === 'PO0000197');
    expect(r.map((x) => x.code)).toEqual(['po_ref_ambiguous']);
    expect(r[0]!.reasons[0]).toMatch(/PO0000197, DUP-1/);
    expect(plan.purchaseOrders.map((p) => p.documentNumber)).not.toContain('PO0000197');
  });
});

describe('L4 (round 8): the stored link of a sent item is found by its Sage reference', () => {
  const owned = (code: string) => ({ ...NONE, items: [{ id: 'uuid-owned', code, system: 'sage', ref: '50001', deleted: false, isActive: true, itemType: 'physical', inventoryTracked: false, stateHash: 'h', hasMovements: false }] }) as never;
  const link = (code: string) => planMigration(parsed(), allResolved(), owned(code)).purchaseOrders.find((p) => p.documentNumber === 'PO0000197')!.stored.lines[0]!.columns.item_id;
  it('an owned item renamed in IsaFlow is still the one: its id, not the "item:CODE" placeholder', () => {
    expect(link('FIB-RENAMED')).toBe('uuid-owned');
    expect(link('FIB-0001')).toBe('uuid-owned');
  });
  it('an item not in the books yet is the placeholder', () => {
    expect(planMigration(parsed(), allResolved(), NONE).purchaseOrders.find((p) => p.documentNumber === 'PO0000197')!.stored.lines[0]!.columns.item_id).toBe('item:FIB-0001');
  });
});
