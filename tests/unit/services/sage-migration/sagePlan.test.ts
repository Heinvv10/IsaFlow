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
import { CONSOLE_ERROR_CHARS, exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import type { MigrationReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const parsed = () => parseSageExport(JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')));
const NONE = { items: [], categories: [], poNumbers: new Map() };
const allResolved = (): Map<string, SupplierResolution> => new Map([['301', { id: SUPPLIER }], ['302', { id: SUPPLIER }], ['303', { id: SUPPLIER }]]);

describe('planMigration', () => {
  it('sends every fixture row, the categories its items use, in Sage id order', () => {
    const plan = planMigration(parsed(), allResolved(), NONE);
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
    expect(planMigration(onlyOptics, allResolved(), NONE).categories.map((c) => c.name)).toEqual(['Optics']);
  });

  it('refuses an item the tool\'s own validator would refuse, with the tool\'s reason, and sends the rest', () => {
    const p = parsed();
    const bad = { ...p, items: [{ ...p.items[0]!, code: '' }, ...p.items.slice(1)] };
    const plan = planMigration(bad, allResolved(), NONE);
    expect(plan.items).toHaveLength(19);
    expect(plan.refusals.filter((r) => r.entity === 'item')).toEqual([{ entity: 'item', sageId: '50001', label: '', code: 'tool_refuses', reasons: [expect.stringMatching(/^invalid_field: code must not be empty/)] }]);
    expect(plan.refusals.filter((r) => r.entity === 'purchase_order').map((r) => r.code)).toEqual(['line_item_refused', 'line_item_refused']); // POs 197 and 202 name that item
  });

  it('refuses a PO whose supplier is unresolved or ambiguous, or was never looked up', () => {
    const resolved = allResolved();
    resolved.set('301', { code: 'supplier_unresolved', reason: 'none' });
    resolved.set('302', { code: 'supplier_ambiguous', reason: 'two' });
    resolved.delete('303');
    const plan = planMigration(parsed(), resolved, NONE);
    expect(plan.purchaseOrders).toHaveLength(0); // 301 has POs 0,3,6,9; 302 has 1,4,7; 303 has 2,5,8
    expect(plan.refusals.map((r) => r.code).sort()).toEqual([...Array(4).fill('supplier_unresolved'), ...Array(3).fill('supplier_ambiguous'), ...Array(3).fill('supplier_unresolved')].sort());
  });

  it('refuses a PO whose lines do not give its header totals, with the tool\'s message naming the PO', () => {
    const p = parsed();
    const po = { ...p.purchaseOrders[0]!, exclusive: p.purchaseOrders[0]!.exclusive + 1, total: p.purchaseOrders[0]!.total + 1 };
    const plan = planMigration({ ...p, purchaseOrders: [po, ...p.purchaseOrders.slice(1)] }, allResolved(), NONE);
    expect(plan.purchaseOrders).toHaveLength(9);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({ entity: 'purchase_order', label: 'PO0000197', code: 'tool_refuses' });
    expect(plan.refusals[0]!.reasons[0]).toMatch(/PO0000197/);
  });

  it('keeps the parser\'s refusals in front of its own', () => {
    const p = { ...parsed(), refusals: [{ entity: 'item' as const, sageId: '1', label: 'X', code: 'invalid_row', reasons: ['r'] }] };
    expect(planMigration(p, allResolved(), NONE).refusals[0]).toMatchObject({ label: 'X' });
  });
});

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
    return { parsed: p, plan: planMigration(p, allResolved(), NONE), live: true, failedBatches: 0, expect: undefined };
  };
  const all = () => {
    const b = base();
    return { b, after: snap(b.plan.items.map((i) => i.sageId), b.plan.purchaseOrders.map((p) => [p.sageId, p.totalCents])) };
  };

  it('is all booked when every sent row is booked at its total and no stock moved', () => {
    const { b, after } = all();
    const r = buildReconciliation({ ...b, before: snap([], []), after });
    expect([r.allSentBooked, r.nothingRefused]).toEqual([true, true]);
  });
  it('nothingRefused follows the plan\'s refusals, whatever happened to the rows that were sent', () => {
    const { b, after } = all();
    const refused = { ...b, plan: { ...b.plan, refusals: [{ entity: 'item' as const, sageId: '1', label: 'X', code: 'c', reasons: ['r'] }] } };
    expect(buildReconciliation({ ...refused, before: snap([], []), after })).toMatchObject({ allSentBooked: true, nothingRefused: false });
  });
  it('is not all booked when one PO is missing, one total differs, a stock movement appeared, or a batch failed', () => {
    const { b, after } = all();
    const before = snap([], []);
    const missing = snap([...after.itemRefs], [...after.poTotals].slice(1));
    expect(buildReconciliation({ ...b, before, after: missing })).toMatchObject({ allSentBooked: false, purchaseOrders: { presentAfter: 9 } });
    const off = snap([...after.itemRefs], [...after.poTotals].map(([k, v], i) => [k, i === 0 ? v + 1 : v] as [string, number]));
    expect(buildReconciliation({ ...b, before, after: off })).toMatchObject({ allSentBooked: false, purchaseOrders: { differenceCents: -1 } });
    expect(buildReconciliation({ ...b, before, after: snap([...after.itemRefs], [...after.poTotals], 1) })).toMatchObject({ allSentBooked: false, stock: { written: 1 } });
    expect(buildReconciliation({ ...b, before, after, failedBatches: 1 }).allSentBooked).toBe(false);
    expect(buildReconciliation({ ...b, before, after, live: false }).allSentBooked).toBe(false);
  });
  it('compares the expected figures with what was sent or booked, not with the export', () => {
    const { b, after } = all();
    const r = buildReconciliation({ ...b, before: snap([], []), after, expect: { items: 20, purchaseOrders: 757, purchaseOrderTotalCents: 1 } });
    expect(r.expected.items).toEqual({ expected: 20, actual: 20, basis: 'booked', ok: true });
    expect(r.expected.purchaseOrders).toEqual({ expected: 757, actual: 10, basis: 'booked', ok: false });
    expect(r.expected.purchaseOrderTotalCents).toMatchObject({ ok: false });
    // A dry run compares with what would be SENT, a refused row counting in neither.
    const dry = buildReconciliation({ ...b, live: false, before: snap([], []), after: snap([], []), expect: { items: 20 } });
    expect(dry.expected.items).toEqual({ expected: 20, actual: 20, basis: 'sent', ok: true });
    const refusing = { ...b, plan: { ...b.plan, items: b.plan.items.slice(1) } };
    expect(buildReconciliation({ ...refusing, live: false, before: snap([], []), after: snap([], []), expect: { items: 20 } }).expected.items).toMatchObject({ actual: 19, ok: false });
  });
  it('F7c: the PO total says how many export rows it leaves out, and the summary warns', () => {
    const { b, after } = all();
    const withGap = { ...b, parsed: { ...b.parsed, exportRowsWithoutTotal: 2 } };
    const reconciliation = buildReconciliation({ ...withGap, before: snap([], []), after });
    expect(reconciliation.purchaseOrders.exportRowsWithoutTotal).toBe(2);
    const phase = { batches: [], failed: 0 };
    const report: MigrationReport = {
      companyId: 'c', status: 'completed', dryRun: { categories: phase, items: phase, purchaseOrders: phase, clean: true },
      live: null, reconciliation, refused: [], budgetWouldHaveFailed: [],
    };
    expect(summaryLines(report).join('\n')).toContain('WARNING: the export PO total leaves out 2 row(s) whose Total is not a number');
    expect(summaryLines({ ...report, reconciliation: buildReconciliation({ ...b, before: snap([], []), after }) }).join('\n')).not.toContain('WARNING');
  });
  it('summaryLines names a mismatch, a refusal and a failed batch', () => {
    const { b, after } = all();
    const reconciliation = buildReconciliation({ ...b, before: snap([], []), after, expect: { purchaseOrders: 757 } });
    const phase = { batches: [], failed: 0 };
    const failedBatch = { entity: 'purchase_order' as const, n: 2, size: 3, key: 'k', status: 'failed' as const, allRowsAlreadyPresent: false, toolReported: null, error: 'boom' };
    const report: MigrationReport = {
      companyId: 'c1', status: 'failed', dryRun: { categories: phase, items: phase, purchaseOrders: phase, clean: true },
      live: { categories: phase, items: phase, purchaseOrders: { batches: [failedBatch], failed: 1 } }, reconciliation, budgetWouldHaveFailed: [],
      refused: [{ entity: 'item', sageId: '5', label: 'FIB-9', code: 'invalid_row', reasons: ['a', 'b'] }],
    };
    const text = summaryLines(report).join('\n');
    expect(text).toContain('company c1: failed');
    expect(text).toContain('MISMATCH purchaseOrders: expected 757, booked 10');
    expect(text).toContain('refused item FIB-9 [invalid_row]: a; b');
    expect(text).toContain('FAILED purchase_order batch 2: boom');
    expect(text).toMatch(/PO total: export R[\d\u00a0 ]+\.\d\d,/);
  });
  it('cuts a long tool refusal on the console only: the report keeps it all', () => {
    const { b, after } = all();
    const reconciliation = buildReconciliation({ ...b, before: snap([], []), after });
    const phase = { batches: [], failed: 0 };
    const long = `refused ${'y'.repeat(9000)} END`;
    const failedBatch = { entity: 'purchase_order' as const, n: 1, size: 3, key: 'k', status: 'failed' as const, allRowsAlreadyPresent: false, toolReported: null, error: long };
    const report: MigrationReport = {
      companyId: 'c1', status: 'failed', dryRun: { categories: phase, items: phase, purchaseOrders: { batches: [failedBatch], failed: 1 }, clean: false },
      live: null, reconciliation, refused: [], budgetWouldHaveFailed: [],
    };
    const line = summaryLines(report).find((l) => l.startsWith('FAILED'))!;
    expect(line.length).toBeLessThan(CONSOLE_ERROR_CHARS + 200);
    expect(line).toContain('the whole text is in the report file');
    expect(line).not.toContain('END');
    expect(failedBatch.error).toBe(long); // the report object is untouched
    expect(JSON.stringify(report)).toContain('END');
  });
});

describe('exitCodeFor', () => {
  const { reconciliation: base } = (() => {
    const p = parsed();
    const plan = planMigration(p, allResolved(), NONE);
    const after = { itemRefs: new Set(plan.items.map((i) => i.sageId)), poTotals: new Map(plan.purchaseOrders.map((x) => [x.sageId, x.totalCents] as [string, number])), stockMovements: 0 };
    return { reconciliation: buildReconciliation({ parsed: p, plan, before: { itemRefs: new Set<string>(), poTotals: new Map<string, number>(), stockMovements: 0 }, after, failedBatches: 0, expect: undefined, live: true }) };
  })();
  const phase = { batches: [], failed: 0 };
  const report = (status: MigrationReport['status'], rec: Partial<typeof base> = {}): MigrationReport => ({
    companyId: 'c', status, refused: [], budgetWouldHaveFailed: [], live: null,
    dryRun: { categories: phase, items: phase, purchaseOrders: phase, clean: status !== 'dry_run_failed' }, reconciliation: { ...base, ...rec },
  });
  const miss = { expected: 5, actual: 4, basis: 'booked' as const, ok: false };

  it('0 for a clean dry run and for a live run that booked everything it sent', () => {
    expect(exitCodeFor(report('dry_run_ok', { allSentBooked: false }), false)).toBe(0);
    expect(exitCodeFor(report('completed'), false)).toBe(0);
  });
  it('1 for a failed dry run or a failed run', () => {
    expect(exitCodeFor(report('dry_run_failed'), true)).toBe(1);
    expect(exitCodeFor(report('failed'), true)).toBe(1);
  });
  it('1 for a completed run whose sent rows are not all booked (a total off, a stock row), whatever is allowed', () => {
    expect(exitCodeFor(report('completed', { allSentBooked: false }), true)).toBe(1);
  });
  it('1 when a row was refused, unless refusals are allowed; a dry run is no different', () => {
    expect(exitCodeFor(report('completed', { nothingRefused: false }), false)).toBe(1);
    expect(exitCodeFor(report('completed', { nothingRefused: false }), true)).toBe(0);
    expect(exitCodeFor(report('dry_run_ok', { nothingRefused: false }), false)).toBe(1);
    expect(exitCodeFor(report('dry_run_ok', { nothingRefused: false }), true)).toBe(0);
  });
  it('1 when any --expect-* figure missed, and no allowance excuses it', () => {
    const missed = { ...base.expected, purchaseOrders: miss };
    expect(exitCodeFor(report('completed', { expected: missed }), true)).toBe(1);
    expect(exitCodeFor(report('dry_run_ok', { expected: missed }), true)).toBe(1);
    expect(exitCodeFor(report('completed', { expected: { ...base.expected, items: { ...miss, ok: true } } }), false)).toBe(0);
  });
});
