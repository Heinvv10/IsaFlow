/** M2: a re-run that finds a PO already there with other figures, or an owned item that would change, says so; exit 1 unless allowed. */
import { describe, expect, it } from 'vitest';
import { differencesFrom } from '@/modules/accounting/services/sage-migration/sageDifferences';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import type { BatchReport, MigrationReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const batch = (entity: BatchReport['entity'], toolReported: Record<string, unknown> | null): BatchReport =>
  ({ entity, n: 1, size: 1, key: 'k', status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported, error: null });

describe('differencesFrom', () => {
  it('lists the POs a batch answered already_existed with payload_differs, with the tool\'s differences', () => {
    const d = differencesFrom([batch('purchase_order', { purchase_orders: [
      { po_number: 'PO1', already_existed: true, payload_differs: false },
      { po_number: 'PO2', already_existed: true, payload_differs: true, differences: [{ field: 'status', existing: 'approved', requested: 'closed' }] },
      { po_number: 'PO3', already_existed: false },
    ] })]);
    expect(d.purchaseOrders).toEqual([{ poNumber: 'PO2', differences: [{ field: 'status', existing: 'approved', requested: 'closed' }] }]);
    expect(d.items).toEqual([]);
  });
  it('lists the items a batch answered updated, with the fields that change; created and unchanged are not differences', () => {
    const d = differencesFrom([batch('item', { rows: [
      { index: 0, outcome: 'created', code: 'A' }, { index: 1, outcome: 'unchanged', code: 'B' }, { index: 2, outcome: 'updated', code: 'C', changed: ['sales_price', 'is_active'] },
    ] })]);
    expect(d.items).toEqual([{ code: 'C', changed: ['sales_price', 'is_active'] }]);
  });
  it('the same PO or item named by two batches (dry run and live) is listed once', () => {
    const po = batch('purchase_order', { purchase_orders: [{ po_number: 'PO1', payload_differs: true, differences: [{ field: 'status', existing: 'a', requested: 'b' }] }] });
    const it = batch('item', { rows: [{ outcome: 'updated', code: 'C', changed: ['is_active'] }] });
    const d = differencesFrom([it, po, it, po]);
    expect(d.purchaseOrders).toHaveLength(1);
    expect(d.items).toEqual([{ code: 'C', changed: ['is_active'] }]);
  });
  it('reads categories as no difference, a failed batch (null answer) as none, and joins every batch', () => {
    const po = (n: string) => ({ purchase_orders: [{ po_number: n, payload_differs: true, differences: [{ field: 'total', existing: 1, requested: 2 }] }] });
    const d = differencesFrom([batch('category', { outcome: 'updated' }), batch('purchase_order', null), batch('purchase_order', po('PO7')), batch('purchase_order', po('PO8'))]);
    expect(d.purchaseOrders.map((x) => x.poNumber)).toEqual(['PO7', 'PO8']);
  });
});

describe('exit code and summary with differences', () => {
  const phase = { batches: [], failed: 0 };
  const base = (): MigrationReport => ({
    companyId: 'c', status: 'completed', refused: [], budgetWouldHaveFailed: [], live: null,
    dryRun: { categories: phase, items: phase, purchaseOrders: phase, clean: true },
    differences: { purchaseOrders: [], items: [] }, liveBlockedBy: [], lineLinks: { linked: 0, basis: 'booked', alreadyThere: [], notLinked: [] },
    reconciliation: {
      items: { presentBefore: 3 }, purchaseOrders: { exportTotalCents: 0, sentTotalCents: 0, notSentTotalCents: 0, bookedTotalCents: 0, differenceCents: 0, exportRowsWithoutTotal: 0 },
      expected: { items: null, purchaseOrders: null, purchaseOrderTotalCents: null }, stock: { written: 0, itemsWithQuantityOnHandIgnored: 0 },
      attachments: { posWithPdf: 0, files: [] }, allSentBooked: true, nothingRefused: true,
    } as never,
  });
  const withPoDiff = (): MigrationReport => ({ ...base(), differences: { purchaseOrders: [{ poNumber: 'PO9', differences: [{ field: 'status', existing: 'approved', requested: 'closed' }] }], items: [] } });
  const withItemDiff = (): MigrationReport => ({ ...base(), differences: { purchaseOrders: [], items: [{ code: 'FIB-1', changed: ['sales_price'] }] } });

  it('exit 0 with none; 1 with a PO difference or an item update, unless differences are allowed', () => {
    expect(exitCodeFor(base(), false, false)).toBe(0);
    for (const r of [withPoDiff(), withItemDiff()]) {
      expect(exitCodeFor(r, false, false)).toBe(1);
      expect(exitCodeFor(r, true, false)).toBe(1); // allowing refusals does not allow differences
      expect(exitCodeFor(r, false, true)).toBe(0);
    }
    expect(exitCodeFor(base(), false)).toBe(0);
  });
  it('allowing differences does not allow refusals, and allowing refusals does not allow differences', () => {
    const refused = { ...base(), reconciliation: { ...base().reconciliation, nothingRefused: false } };
    expect(exitCodeFor(refused, false, true)).toBe(1);
    expect(exitCodeFor(refused, true, false)).toBe(0);
    expect(exitCodeFor(withPoDiff(), true, false)).toBe(1);
  });
  it('the summary lists each difference and says the stored PO is not changed', () => {
    const t = summaryLines(withPoDiff()).join('\n');
    expect(t).toContain('PO9 is already in IsaFlow with other figures than Sage');
    expect(t).toContain('status approved -> closed');
    expect(t).toContain('not changed');
    const i = summaryLines(withItemDiff()).join('\n');
    expect(i).toContain('FIB-1 would be updated to Sage\'s values: sales_price');
  });
  it('L2: when items are already there, the summary says a re-run sets them back to Sage\'s values (IsaFlow edits are overwritten)', () => {
    expect(summaryLines(base()).join('\n')).toMatch(/re-run sets .*items and categories .* back to Sage's values.*overwritten/s);
    const none = base();
    (none.reconciliation.items as { presentBefore: number }).presentBefore = 0;
    expect(summaryLines(none).join('\n')).not.toMatch(/overwritten/);
  });

  it('the summary warns loudly when rows were refused and nothing at all is sent or booked', () => {
    const none = base();
    (none.reconciliation.items as Record<string, number>).sent = 0;
    (none.reconciliation.purchaseOrders as unknown as Record<string, number>).sent = 0;
    const r: MigrationReport = { ...none, reconciliation: { ...none.reconciliation, nothingRefused: false } };
    expect(summaryLines(r).join('\n')).toMatch(/^WARNING: every row was refused: nothing is imported/m);
    expect(summaryLines(none).join('\n')).not.toMatch(/every row was refused/);
    const some = base();
    (some.reconciliation.items as Record<string, number>).sent = 4;
    expect(summaryLines({ ...some, reconciliation: { ...some.reconciliation, nothingRefused: false } }).join('\n')).not.toMatch(/every row was refused/);
  });

  it('a run whose live phase was blocked says why, exits 1, and lists the reasons', () => {
    const r: MigrationReport = { ...base(), status: 'live_blocked', liveBlockedBy: ['--expect-pos 3, but the dry run would send 10'] };
    expect(exitCodeFor(r, true, true)).toBe(1);
    const t = summaryLines(r).join('\n');
    expect(t).toContain('company c: live_blocked');
    expect(t).toContain('LIVE NOT STARTED: --expect-pos 3, but the dry run would send 10');
  });

  it('the summary counts linked lines and lists each line not linked, with why', () => {
    const r: MigrationReport = { ...base(), lineLinks: { linked: 3, basis: 'booked', alreadyThere: [], notLinked: [
      { poNumber: 'PO1', line: 2, itemCode: 'A-1', reason: 'inactive' }, { poNumber: 'PO2', line: 1, itemCode: 'B-2', reason: 'refused' },
    ] } };
    const t = summaryLines(r).join('\n');
    expect(t).toContain('PO lines linked to their item: 3 (counted in the books); not linked: 2');
    expect(t).toContain('line not linked: item inactive: PO1 line 2 (A-1), sent with " [item A-1]" in its description');
    expect(t).toContain('line not linked: item refused: PO2 line 1 (B-2)');
    expect(summaryLines(base()).join('\n')).toContain('PO lines linked to their item: 0 (counted in the books); not linked: 0');
    expect(t).toContain('not linked lines are informational: they do not change the exit code');
    expect(summaryLines(base()).join('\n')).not.toContain('informational');
  });

  it('L5: not-linked lines never change the exit code (the item code stays in the description), and the summary says so', () => {
    const r: MigrationReport = { ...base(), lineLinks: { linked: 0, basis: 'booked', alreadyThere: [], notLinked: [{ poNumber: 'PO1', line: 1, itemCode: 'A', reason: 'refused' }] } };
    expect(exitCodeFor(r, false, false)).toBe(0);
    expect(summaryLines(r).join('\n')).toContain('not linked lines are informational: they do not change the exit code');
  });
});
