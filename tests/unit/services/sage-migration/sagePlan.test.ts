/**
 * What the runner sends and what it refuses first (sageMigrationPlan), how it batches and keys (sageBatches), and the lines a
 * person reads (sageReportSummary). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { planMigration } from '@/modules/accounting/services/sage-migration/sageMigrationPlan';
import type { SupplierResolution } from '@/modules/accounting/services/sage-migration/sageSuppliers';
import { batchKey, byStableKey, chunk, MAX_ITEM_BATCH, MAX_PO_BATCH } from '@/modules/accounting/services/sage-migration/sageBatches';
import { buildReconciliation } from '@/modules/accounting/services/sage-migration/sageReconciliation';
import { summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import type { MigrationReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const parsed = () => parseSageExport(JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')));
const allResolved = (): Map<string, SupplierResolution> => new Map([['301', { id: SUPPLIER }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]);

describe('planMigration', () => {
  it('sends every fixture row, the categories its items use, in Sage id order', () => {
    const plan = planMigration(parsed(), allResolved());
    expect(plan.refusals).toEqual([]);
    expect(plan.items).toHaveLength(20);
    expect(plan.items.map((i) => i.sageId)).toEqual(Array.from({ length: 20 }, (_, n) => String(50001 + n)));
    expect(plan.categories.map((c) => c.name)).toEqual(['Optics', 'Poles and Hardware', 'Services', 'Tools']);
    expect(plan.purchaseOrders.map((p) => p.documentNumber)).toEqual(Array.from({ length: 10 }, (_, i) => `PO${String(197 + i).padStart(7, '0')}`));
    expect(plan.purchaseOrders.reduce((s, p) => s + p.totalCents, 0)).toBe(parsed().exportPoTotalCents);
  });

  it('sends only the categories a SENT item uses', () => {
    const p = parsed();
    const onlyOptics = { ...p, items: p.items.filter((i) => i.category?.description === 'Optics') };
    expect(planMigration(onlyOptics, allResolved()).categories.map((c) => c.name)).toEqual(['Optics']);
  });

  it('refuses an item the tool\'s own validator would refuse, with the tool\'s reason, and sends the rest', () => {
    const p = parsed();
    const bad = { ...p, items: [{ ...p.items[0]!, code: '' }, ...p.items.slice(1)] };
    const plan = planMigration(bad, allResolved());
    expect(plan.items).toHaveLength(19);
    expect(plan.refusals).toEqual([{ entity: 'item', sageId: '50001', label: '', code: 'tool_refuses', reasons: [expect.stringMatching(/^invalid_field: code must not be empty/)] }]);
  });

  it('refuses a PO whose supplier is unresolved or ambiguous, or was never looked up', () => {
    const resolved = allResolved();
    resolved.set('301', { code: 'supplier_unresolved', reason: 'none' });
    resolved.set('302', { code: 'supplier_ambiguous', reason: 'two' });
    resolved.delete('303');
    const plan = planMigration(parsed(), resolved);
    expect(plan.purchaseOrders).toHaveLength(0); // 301 has POs 0,3,6,9; 302 has 1,4,7; 303 has 2,5,8
    expect(plan.refusals.map((r) => r.code).sort()).toEqual([...Array(4).fill('supplier_unresolved'), ...Array(3).fill('supplier_ambiguous'), ...Array(3).fill('supplier_unresolved')].sort());
  });

  it('refuses a PO whose lines do not give its header totals, with the tool\'s message naming the PO', () => {
    const p = parsed();
    const po = { ...p.purchaseOrders[0]!, exclusive: p.purchaseOrders[0]!.exclusive + 1, total: p.purchaseOrders[0]!.total + 1 };
    const plan = planMigration({ ...p, purchaseOrders: [po, ...p.purchaseOrders.slice(1)] }, allResolved());
    expect(plan.purchaseOrders).toHaveLength(9);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({ entity: 'purchase_order', label: 'PO0000197', code: 'tool_refuses' });
    expect(plan.refusals[0]!.reasons[0]).toMatch(/PO0000197/);
  });

  it('keeps the parser\'s refusals in front of its own', () => {
    const p = { ...parsed(), refusals: [{ entity: 'item' as const, sageId: '1', label: 'X', code: 'invalid_row', reasons: ['r'] }] };
    expect(planMigration(p, allResolved()).refusals[0]).toMatchObject({ label: 'X' });
  });
});

describe('batching and keys', () => {
  it('chunks to the size given, the last one short, and refuses a size that is not a positive integer', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(/positive integer/);
    expect(() => chunk([1], 1.5)).toThrow(/positive integer/);
  });
  it('the tool limits are 500 items and 100 purchase orders a call', () => {
    expect([MAX_ITEM_BATCH, MAX_PO_BATCH]).toEqual([500, 100]);
  });
  it('the same rows in the same position give the same key; other rows, another position or another entity give another', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    expect(batchKey('item', 1, rows)).toBe(batchKey('item', 1, [{ a: 1 }, { a: 2 }]));
    expect(batchKey('item', 1, rows)).toMatch(/^sage-mig-item-0001-[0-9a-f]{16}$/);
    expect(batchKey('item', 1, rows)).not.toBe(batchKey('item', 1, [{ a: 1 }, { a: 3 }]));
    expect(batchKey('item', 1, rows)).not.toBe(batchKey('item', 2, rows));
    expect(batchKey('item', 1, rows)).not.toBe(batchKey('purchase_order', 1, rows));
  });
  it('orders numeric ids numerically and other keys as text, whatever the input order', () => {
    expect(byStableKey(['10', '9', '100', '1'], (x) => x)).toEqual(['1', '9', '10', '100']);
    expect(byStableKey(['b', 'a', 'c'], (x) => x)).toEqual(['a', 'b', 'c']);
    expect(byStableKey(['900000000000000000', '9'], (x) => x)).toEqual(['9', '900000000000000000']);
  });
});

describe('reconciliation and its lines', () => {
  const snap = (items: string[], pos: Array<[string, number]>, stock = 0) => ({ itemRefs: new Set(items), poTotals: new Map(pos), stockMovements: stock });
  const base = () => {
    const p = parsed();
    return { parsed: p, plan: planMigration(p, allResolved()), live: true, failedBatches: 0, expect: undefined };
  };
  const all = () => {
    const b = base();
    return { b, after: snap(b.plan.items.map((i) => i.sageId), b.plan.purchaseOrders.map((p) => [p.sageId, p.totalCents])) };
  };

  it('is complete when every sent row is booked at its total and no stock moved', () => {
    const { b, after } = all();
    expect(buildReconciliation({ ...b, before: snap([], []), after }).complete).toBe(true);
  });
  it('is not complete when one PO is missing, one total differs, a stock movement appeared, or a batch failed', () => {
    const { b, after } = all();
    const before = snap([], []);
    const missing = snap([...after.itemRefs], [...after.poTotals].slice(1));
    expect(buildReconciliation({ ...b, before, after: missing })).toMatchObject({ complete: false, purchaseOrders: { presentAfter: 9 } });
    const off = snap([...after.itemRefs], [...after.poTotals].map(([k, v], i) => [k, i === 0 ? v + 1 : v] as [string, number]));
    expect(buildReconciliation({ ...b, before, after: off })).toMatchObject({ complete: false, purchaseOrders: { differenceCents: -1 } });
    expect(buildReconciliation({ ...b, before, after: snap([...after.itemRefs], [...after.poTotals], 1) })).toMatchObject({ complete: false, stock: { written: 1 } });
    expect(buildReconciliation({ ...b, before, after, failedBatches: 1 }).complete).toBe(false);
    expect(buildReconciliation({ ...b, before, after, live: false }).complete).toBe(false);
  });
  it('compares the expected figures with the export\'s', () => {
    const { b, after } = all();
    const r = buildReconciliation({ ...b, before: snap([], []), after, expect: { items: 20, purchaseOrders: 757, purchaseOrderTotalCents: 1 } });
    expect(r.expected.items).toEqual({ expected: 20, actual: 20, ok: true });
    expect(r.expected.purchaseOrders).toEqual({ expected: 757, actual: 10, ok: false });
    expect(r.expected.purchaseOrderTotalCents).toMatchObject({ ok: false });
  });
  it('summaryLines names a mismatch, a refusal and a failed batch', () => {
    const { b, after } = all();
    const reconciliation = buildReconciliation({ ...b, before: snap([], []), after, expect: { purchaseOrders: 757 } });
    const phase = { batches: [], failed: 0 };
    const failedBatch = { entity: 'purchase_order' as const, n: 2, size: 3, key: 'k', status: 'failed' as const, allRowsAlreadyPresent: false, toolReported: null, error: 'boom' };
    const report: MigrationReport = {
      companyId: 'c1', status: 'failed', dryRun: { categories: phase, items: phase, purchaseOrders: phase, clean: true },
      live: { categories: phase, items: phase, purchaseOrders: { batches: [failedBatch], failed: 1 } }, reconciliation,
      refused: [{ entity: 'item', sageId: '5', label: 'FIB-9', code: 'invalid_row', reasons: ['a', 'b'] }],
    };
    const text = summaryLines(report).join('\n');
    expect(text).toContain('company c1: failed');
    expect(text).toContain('MISMATCH purchaseOrders: expected 757, export has 10');
    expect(text).toContain('refused item FIB-9 [invalid_row]: a; b');
    expect(text).toContain('FAILED purchase_order batch 2: boom');
    expect(text).toMatch(/PO total: export R[\d\u00a0 ]+\.\d\d,/);
  });
});
