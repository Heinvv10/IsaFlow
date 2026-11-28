/**
 * The plan against the purchase orders and suppliers the company already holds (split from sagePlanExisting.test.ts, which passed the
 * 300-line cap): inactive suppliers, POs this migration already booked, PO references held twice, the stored links of sent items.
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
