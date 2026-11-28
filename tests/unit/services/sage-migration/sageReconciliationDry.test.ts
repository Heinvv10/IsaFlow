/**
 * Round-10 review L3: a dry run books nothing, so the report's bookedTotalCents and differenceCents are null (the console prints n/a),
 * never figures computed on the books as they were before the run. A live run keeps both.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { planMigration } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';
import type { SupplierResolution } from '@/modules/accounting/services/sage-migration/sageSuppliers';
import { buildReconciliation } from '@/modules/accounting/services/sage-migration/sageReconciliation';

const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const parsed = () => parseSageExport(JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')));
const NONE = { items: [], categories: [], poNumbers: new Map(), inactiveSuppliers: new Set<string>() };
const resolved = (): Map<string, SupplierResolution> => new Map([['301', { id: SUPPLIER }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]);
const snap = (pos: Array<[string, number]>) => ({
  itemRefs: new Set<string>(), poTotals: new Map(pos), stockMovements: 0, items: [], categories: [], supplierSageRefs: new Map<string, string>(), poNumbers: new Map(),
  poStates: new Map<string, string>(), poLinkedLines: new Map<string, number>(), poContent: new Map(), inactiveSuppliers: new Set<string>(),
});

describe('L3: the PO total figures of a dry run', () => {
  const p = parsed();
  const plan = planMigration(p, resolved(), NONE);
  const first = plan.purchaseOrders[0]!;
  // Before the run one PO is already booked: the old code reported it as "booked" and the rest as the "difference".
  const before = snap([[first.sageId, first.totalCents]]);

  it('are null on a dry run, whatever the books held before', () => {
    const dry = buildReconciliation({ parsed: p, plan, before, after: before, failedBatches: 0, expect: undefined, live: false });
    expect(dry.purchaseOrders.bookedTotalCents).toBeNull();
    expect(dry.purchaseOrders.differenceCents).toBeNull();
    // the figures that ARE known on a dry run stay
    expect(dry.purchaseOrders.sentTotalCents).toBe(plan.purchaseOrders.reduce((n, x) => n + x.totalCents, 0));
    expect(JSON.parse(JSON.stringify(dry)).purchaseOrders).toMatchObject({ bookedTotalCents: null, differenceCents: null });
  });
  it('are measured on a live run', () => {
    const after = snap(plan.purchaseOrders.map((x) => [x.sageId, x.totalCents] as [string, number]));
    const live = buildReconciliation({ parsed: p, plan, before, after, failedBatches: 0, expect: undefined, live: true });
    expect(live.purchaseOrders.bookedTotalCents).toBe(live.purchaseOrders.sentTotalCents);
    expect(live.purchaseOrders.differenceCents).toBe(0);
  });
});
