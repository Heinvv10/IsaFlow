/**
 * Round-10 review MED / breaker B10-1: after a live run the summary says an owned item or category "was updated" only when the live batch
 * that carried it is ok (checked against the books). A phase that never ran wrote nothing ("would be updated (not written: ...)"), a failed
 * batch that rolled back is not in the books ("would be updated (not in the books: ...)"); one that committed and was then changed by
 * another writer "was updated ..., then changed in the books since (check)". An unconfirmed COMMIT never reaches a report (the run stops,
 * round 10). A dry run says "would be updated" as before.
 */
import { describe, expect, it } from 'vitest';
import { summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import type { BatchReport, MigrationReport, PhaseReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const WAS = "was updated to Sage's values (an IsaFlow edit of these fields was overwritten)";
const itemBatch = (n: number, codes: string[], over: Partial<BatchReport> = {}): BatchReport => ({
  entity: 'item', n, size: codes.length, key: `sage-mig-item-000${n}-x`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, error: null,
  toolReported: { rows: codes.map((code) => ({ outcome: 'updated', code, changed: ['description'] })) }, ...over,
});
const categoryBatch = (n: number, name: string, over: Partial<BatchReport> = {}): BatchReport => ({
  entity: 'category', n, size: 1, key: `sage-mig-category-000${n}-x`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, error: null,
  toolReported: { outcome: 'updated', name, changed: ['name'] }, ...over,
});
const phase = (batches: BatchReport[]): PhaseReport => ({ batches, failed: batches.filter((b) => b.status === 'failed').length });
const failed = (b: BatchReport, error = 'refused'): BatchReport => ({ ...b, status: 'failed', toolReported: null, error });
const NOT_RUN: PhaseReport = { batches: [], failed: 0, skipped: true };

/** The dry run named FIB-1 (item batch 1), FIB-2 (item batch 2) and Optics (category batch 1) as owned rows Sage's values would change. */
const report = (live: MigrationReport['live']): MigrationReport => ({
  companyId: 'c', status: 'completed', refused: [], budgetWouldHaveFailed: [], liveBlockedBy: [],
  dryRun: { categories: phase([categoryBatch(1, 'Optics')]), items: phase([itemBatch(1, ['FIB-1']), itemBatch(2, ['FIB-2'])]), purchaseOrders: phase([]), clean: true },
  live,
  differences: { purchaseOrders: [], items: [{ code: 'FIB-1', changed: ['description'] }, { code: 'FIB-2', changed: ['description'] }], categories: [{ name: 'Optics', changed: ['name'] }] },
  lineLinks: { linked: 0, basis: 'booked', alreadyThere: [], notLinked: [] },
  reconciliation: {
    items: { presentBefore: 0 }, purchaseOrders: { exportTotalCents: 0, sentTotalCents: 0, notSentTotalCents: 0, bookedTotalCents: 0, differenceCents: 0, exportRowsWithoutTotal: 0 },
    expected: { items: null, purchaseOrders: null, purchaseOrderTotalCents: null }, stock: { written: 0, itemsWithQuantityOnHandIgnored: 0 },
    attachments: { posWithPdf: 0, files: [] }, allSentBooked: true, nothingRefused: true,
  } as never,
});
const line = (r: MigrationReport, what: string) => summaryLines(r).find((l) => l.startsWith(`DIFFERS: ${what} `))!;

describe('the wording of an owned row Sage\'s values change, after a live run', () => {
  it('batch ok: "was updated"', () => {
    const r = report({ categories: phase([categoryBatch(1, 'Optics')]), items: phase([itemBatch(1, ['FIB-1']), itemBatch(2, ['FIB-2'])]), purchaseOrders: phase([]) });
    expect(line(r, 'item FIB-1')).toContain(WAS);
    expect(line(r, 'category Optics')).toContain(WAS);
  });
  it('items phase not run (a category failed): the item "would be updated (not written: the items phase did not run)"; the FAILED category is not "was updated"', () => {
    const r = report({ categories: phase([failed(categoryBatch(1, 'Optics'), 'the category in the books is not what this batch sent')]), items: NOT_RUN, purchaseOrders: NOT_RUN });
    expect(line(r, 'item FIB-1')).toBe("DIFFERS: item FIB-1 would be updated to Sage's values (not written: the items phase did not run): description");
    expect(line(r, 'category Optics')).toBe("DIFFERS: category Optics would be updated to Sage's values (not in the books: category batch 1 failed): name");
    expect(summaryLines(r).join('\n')).not.toMatch(/was updated|was overwritten/);
  });
  it('a failed item batch: its items "would be updated (not in the books: item batch N failed)", the items of an ok batch "was updated"', () => {
    const r = report({ categories: phase([categoryBatch(1, 'Optics')]), items: phase([failed(itemBatch(1, ['FIB-1'])), itemBatch(2, ['FIB-2'])]), purchaseOrders: phase([]) });
    expect(line(r, 'item FIB-1')).toBe("DIFFERS: item FIB-1 would be updated to Sage's values (not in the books: item batch 1 failed): description");
    expect(line(r, 'item FIB-2')).toContain(WAS);
  });
  it('a batch the registry answered from a STORED answer (rows absent) is "would be ... nothing written", never "was updated"', () => {
    const r = report({ categories: phase([categoryBatch(1, 'Optics')]), items: phase([{ ...itemBatch(1, ['FIB-1']), status: 'failed', rowsAbsent: 1, replayed: true }, itemBatch(2, ['FIB-2'])]), purchaseOrders: phase([]) });
    expect(line(r, 'item FIB-1')).toMatch(/would be updated to Sage's values \(not in the books: item batch 1 was answered from a stored answer, nothing written\)/);
  });
  it('B11-2 (round 11): a batch that COMMITTED and then failed the check against the books: "was updated ..., then changed in the books since"', () => {
    const changed = (b: BatchReport, rows: string[]): BatchReport => ({ ...b, status: 'failed', changedAfterCommit: true, changedRows: rows, error: 'the items in the books are not what this batch sent' });
    const r = report({ categories: phase([changed(categoryBatch(1, 'Optics'), ['Optics'])]), items: NOT_RUN, purchaseOrders: NOT_RUN });
    expect(line(r, 'category Optics')).toBe("DIFFERS: category Optics was updated to Sage's values, then changed in the books since (check): name");
    const i = report({ categories: phase([categoryBatch(1, 'Optics')]), items: phase([changed(itemBatch(1, ['FIB-1']), ['FIB-1']), failed(itemBatch(2, ['FIB-2']))]), purchaseOrders: NOT_RUN });
    expect(line(i, 'item FIB-1')).toBe("DIFFERS: item FIB-1 was updated to Sage's values, then changed in the books since (check): description");
    expect(line(i, 'item FIB-2')).toMatch(/would be updated to Sage's values \(not in the books: item batch 2 failed\)/); // rolled back: as before
  });
  it('R1 (round 12): only the rows the books check named read "then changed"; the other rows of that batch read "another row of its batch changed"', () => {
    const b = { ...itemBatch(1, ['FIB-1', 'FIB-2']), status: 'failed' as const, changedAfterCommit: true as const, changedRows: ['FIB-0003'], error: 'x' };
    const r = report({ categories: phase([categoryBatch(1, 'Optics')]), items: phase([b]), purchaseOrders: NOT_RUN });
    expect(line(r, 'item FIB-1')).toBe("DIFFERS: item FIB-1 was updated to Sage's values (another row of its batch changed since: check): description");
    expect(line(r, 'item FIB-2')).toBe("DIFFERS: item FIB-2 was updated to Sage's values (another row of its batch changed since: check): description");
  });
  it('the structural rule: a live answer is read before the dry run\'s; a live "unchanged" is never worded from the dry run\'s "updated"', () => {
    const unchanged = { ...itemBatch(1, []), toolReported: { rows: [{ code: 'FIB-1', outcome: 'unchanged' }, { code: 'FIB-2', outcome: 'updated', changed: ['description'] }] } };
    const r = report({ categories: phase([categoryBatch(1, 'Optics')]), items: phase([unchanged, itemBatch(2, [])]), purchaseOrders: NOT_RUN });
    expect(line(r, 'item FIB-1')).toBe("DIFFERS: item FIB-1 not updated by the live run (item batch 1 answered unchanged for it: check the books): description");
    // FIB-2: the dry run put it in batch 2, the LIVE answer of batch 1 updated it: worded from batch 1's answer
    expect(line(r, 'item FIB-2')).toContain("was updated to Sage's values (an IsaFlow edit of these fields was overwritten)");
    const cat = report({ categories: phase([{ ...categoryBatch(1, 'Optics'), toolReported: { outcome: 'unchanged', name: 'Optics' } }]), items: NOT_RUN, purchaseOrders: NOT_RUN });
    expect(line(cat, 'category Optics')).toMatch(/not updated by the live run \(category batch 1 answered unchanged/);
  });
  it('a row whose batch is not in the report is never "was updated"', () => {
    const r = report({ categories: phase([]), items: phase([]), purchaseOrders: phase([]) });
    expect(line(r, 'item FIB-1')).toMatch(/may have been updated to Sage's values \(its batch is not in the report: check the books\)/);
  });
  it('a dry run: "would be updated", as before', () => {
    expect(line(report(null), 'item FIB-1')).toBe("DIFFERS: item FIB-1 would be updated to Sage's values: description");
    expect(line(report(null), 'category Optics')).toBe("DIFFERS: category Optics would be updated to Sage's values: name");
  });
});
