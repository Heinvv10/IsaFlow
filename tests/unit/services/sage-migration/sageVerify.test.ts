/**
 * Round-12 review R2: the runner's checks against the books and what it hands a stop, held by unit tests (they were held only by the
 * integration suites). sageVerify is PURE: a hand-built Send list and snapshot.
 */
import { describe, expect, it } from 'vitest';
import { recordSent, settleCommitted, stoppedBatches, unconfirmedBatch, verifiedCategories, verifiedItems, type Sent } from '@/modules/accounting/services/sage-migration/sageVerify';
import type { Send } from '@/modules/accounting/services/sage-migration/sageBatchRun';
import type { BatchReport, PhaseReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
import type { Snapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';

const batch = (entity: BatchReport['entity'], n: number, over: Partial<BatchReport> = {}): BatchReport =>
  ({ entity, n, size: 2, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: { rows: [] }, error: null, ...over });
const phase = (...batches: BatchReport[]): PhaseReport => ({ batches, failed: batches.filter((b) => b.status === 'failed').length });
const itemSend = (n: number, ids: string[]): Send => ({
  entity: 'item', n, tool: 'bulk_upsert_items', args: {}, size: ids.length, present: () => false, labelOf: (id) => `FIB-${id}`,
  absent: (after) => ids.filter((id) => !after.itemRefs.has(id)),
  itemSent: ids.map((id) => ({ sageId: id, code: `FIB-${id}`, isActive: true, itemType: 'physical', inventoryTracked: false })),
});
const catSend = (n: number, ref: string, name: string): Send => ({
  entity: 'category', n, tool: 'upsert_item_category', args: {}, size: 1, present: () => false, labelOf: () => name,
  absent: (after) => (after.categories.some((c) => c.ref === ref) ? [] : [ref]), categorySent: { sageId: ref, name, isActive: true },
});
const item = (id: string, over: Record<string, unknown> = {}) => ({ id: `u${id}`, code: `FIB-${id}`, system: 'sage', ref: id, deleted: false, itemType: 'physical', inventoryTracked: false, isActive: true, stateHash: 'h', ...over });
const snap = (items: ReturnType<typeof item>[], categories: Array<{ ref: string; name: string; isActive?: boolean }> = []): Snapshot => ({
  itemRefs: new Set(items.filter((i) => !i.deleted).map((i) => i.ref)), items, poTotals: new Map(), stockMovements: 0, supplierSageRefs: new Map(), poNumbers: new Map(),
  poStates: new Map(), poLinkedLines: new Map(), poContent: new Map(), inactiveSuppliers: new Set(),
  categories: categories.map((c) => ({ id: `c${c.ref}`, name: c.name, system: 'sage', ref: c.ref, isActive: c.isActive ?? true, stateHash: 'h' })),
} as never);

describe('verifiedItems', () => {
  it('a batch the tool RAN whose items the books hold otherwise: changedAfterCommit, only those rows in changedRows', () => {
    const v = verifiedItems(phase(batch('item', 1)), [itemSend(1, ['1', '2'])], snap([item('1'), item('2', { isActive: false })]));
    expect(v.failed).toBe(1);
    expect(v.batches[0]).toMatchObject({ status: 'failed', changedAfterCommit: true, changedRows: ['FIB-2'] });
    expect(v.batches[0]!.error).toMatch(/FIB-2 \(Sage id 2\): is_active is false, sent true/);
  });
  it('a row removed since AND another changed: both named, the absent one first', () => {
    const v = verifiedItems(phase(batch('item', 1)), [itemSend(1, ['1', '2'])], snap([item('2', { isActive: false })]));
    expect(v.batches[0]).toMatchObject({ changedAfterCommit: true, changedRows: ['FIB-1', 'FIB-2'], rowsAbsent: 1 });
  });
  it('a stored answer (replayed) gets no changedAfterCommit: it wrote nothing', () => {
    const v = verifiedItems(phase(batch('item', 1, { replayed: true })), [itemSend(1, ['1', '2'])], snap([item('1'), item('2', { isActive: false })]));
    expect(v.batches[0]!.status).toBe('failed');
    expect(v.batches[0]!.changedAfterCommit).toBeUndefined();
  });
  it('books as sent: the batch stays ok; a batch that failed before (rolled back) is left as it was', () => {
    const rolled = batch('item', 2, { status: 'failed', toolReported: null, error: 'refused' });
    const v = verifiedItems(phase(batch('item', 1), rolled), [itemSend(1, ['1']), itemSend(2, ['2'])], snap([item('1'), item('2', { isActive: false })]));
    expect(v.batches).toEqual([batch('item', 1), rolled]);
  });
});

describe('verifiedCategories', () => {
  it('a category renamed since its COMMIT: changedAfterCommit naming it; another category is untouched', () => {
    const v = verifiedCategories(phase(batch('category', 1), batch('category', 2)), [catSend(1, '10', 'Optics'), catSend(2, '11', 'Tools')], snap([], [{ ref: '10', name: 'Optics X' }, { ref: '11', name: 'Tools' }]));
    expect(v.batches[0]).toMatchObject({ status: 'failed', changedAfterCommit: true, changedRows: ['Optics'] });
    expect(v.batches[1]!.status).toBe('ok');
  });
});

describe('recordSent and stoppedBatches', () => {
  it('ok and unconfirmed batches are committed, the others failed; the stop gets the failed ones and the dry run\'s category and item batches', () => {
    const sent: Sent = { committed: [], failed: [] };
    const ok = batch('item', 1);
    const lost = batch('item', 2, { status: 'failed', commitUnconfirmed: true });
    const refused = batch('item', 3, { status: 'failed', toolReported: null, error: 'refused' });
    for (const b of [ok, lost, refused]) recordSent(sent, b);
    expect(sent).toEqual({ committed: [ok, lost], failed: [refused] });
    const dry = { categories: phase(batch('category', 1)), items: phase(batch('item', 1), batch('item', 2)) };
    expect(stoppedBatches(sent, dry)).toEqual({ failed: [refused], dryRun: [batch('category', 1), batch('item', 1), batch('item', 2)] });
  });
});

describe('unconfirmedBatch (B12-1, L3 round 13)', () => {
  const failed = batch('item', 2, { status: 'failed', toolReported: null, error: 'COMMIT did not answer' });
  it('keeps the live answer the request had', () => {
    const live = batch('item', 2, { toolReported: { rows: [{ code: 'FIB-1', outcome: 'updated' }] } });
    expect(unconfirmedBatch(failed, live)).toMatchObject({ commitUnconfirmed: true, toolReported: live.toolReported, error: 'COMMIT did not answer' });
    expect(unconfirmedBatch(failed, { ...live, replayed: true }).replayed).toBe(true);
  });
  it('a batch the tool REFUSED keeps the refusal: toolRefused, its reason, no answer', () => {
    const refused = batch('item', 2, { status: 'failed', toolReported: null, error: 'code_in_use: FIB-1' });
    expect(unconfirmedBatch(failed, refused)).toMatchObject({ commitUnconfirmed: true, toolRefused: true, toolReported: null,
      error: 'the tool refused this batch (code_in_use: FIB-1); its COMMIT was not confirmed (COMMIT did not answer)' });
  });
  it('no result at all: no answer', () => {
    expect(unconfirmedBatch(failed, undefined)).toMatchObject({ commitUnconfirmed: true, toolReported: null });
  });
});

describe('settleCommitted (L6, round 13): a stop checks its committed batches as the live phases do', () => {
  const all = { categories: [catSend(1, '10', 'Optics')], items: [itemSend(1, ['1', '2'])], purchaseOrders: [] };
  it('an item batch whose items the books hold otherwise is changedAfterCommit, not plain committed; a category likewise', () => {
    const [cat, items] = settleCommitted([batch('category', 1), batch('item', 1)], all, snap([item('1'), item('2', { isActive: false })], [{ ref: '10', name: 'Optics X' }]));
    expect(cat).toMatchObject({ status: 'failed', changedAfterCommit: true, changedRows: ['Optics'] });
    expect(items).toMatchObject({ status: 'failed', changedAfterCommit: true, changedRows: ['FIB-2'] });
  });
  it('books as sent: unchanged; an unconfirmed batch is left as it is', () => {
    const lost = batch('item', 1, { status: 'failed', commitUnconfirmed: true });
    const books = snap([item('1'), item('2')], [{ ref: '10', name: 'Optics' }]);
    expect(settleCommitted([batch('category', 1), batch('item', 1), lost], all, books)).toEqual([batch('category', 1), batch('item', 1), lost]);
  });
});
