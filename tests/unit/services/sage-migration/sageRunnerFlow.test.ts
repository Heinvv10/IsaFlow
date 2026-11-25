/**
 * Round-14 review R14-L4: the runner's control flow, held by unit tests (mutants of it survived the unit suite). runSageMigration runs with
 * its database seams mocked (guard, run lock, tool session, snapshot, suppliers) and sendBatch faked over an in-memory "books", so each gate
 * is driven directly:
 *   - the DRY run starts the items phase only when no category batch failed (and the POs only when items did not fail either);
 *   - the LIVE run is not started on differences the person did not allow (liveBlockers), and is with --allow-differences;
 *   - the LIVE items phase does not start behind a failed category batch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';
import type { Send } from '@/modules/accounting/services/sage-migration/sageBatchRun';
import type { Snapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';

const h = vi.hoisted(() => ({
  books: { cats: [] as Array<{ ref: string; name: string }>, items: [] as Array<{ ref: string; code: string }>, pos: new Map<string, number>() },
  fail: new Set<string>(), // "<entity> <dry|live>" batches answered failed
  updated: false, // the dry and live item answers say "updated" (a difference)
  sent: [] as string[],
}));
const SUPPLIER = '0f7d6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
vi.mock('@/modules/accounting/services/sage-migration/localGuard', () => ({ assertLocalDatabase: () => undefined, assertLocalPool: () => undefined }));
vi.mock('@/modules/accounting/services/sage-migration/sageRunLock', () => ({ acquireRunLock: async () => ({ check: async () => undefined, unlock: async () => undefined }) }));
vi.mock('@/modules/accounting/services/sage-migration/sageToolSession', () => ({
  CommitUnconfirmedError: class extends Error {},
  withToolSession: async (_p: unknown, _c: unknown, _u: unknown, _commit: boolean, fn: (s: unknown) => unknown) => fn({ companyId: 'c', call: async () => ({ isError: false, text: '{}', body: {} }) }),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageSuppliers', () => ({ resolveSuppliers: async () => new Map([['301', { id: SUPPLIER }]]) }));
vi.mock('@/modules/accounting/services/sage-migration/sageSnapshot', () => ({
  readSnapshot: async (): Promise<Snapshot> => ({
    itemRefs: new Set(h.books.items.map((i) => i.ref)), poTotals: new Map(h.books.pos), poStates: new Map(), poLinkedLines: new Map(), poContent: new Map(), duplicatePoRefs: new Map(),
    stockMovements: 0, budgetPolicy: 'warn', inactiveSuppliers: new Set(), supplierSageRefs: new Map(), poNumbers: new Map(),
    items: h.books.items.map((i) => ({ id: `u${i.ref}`, code: i.code, system: 'sage', ref: i.ref, deleted: false, itemType: 'physical', inventoryTracked: false, isActive: true, stateHash: 'h' })),
    categories: h.books.cats.map((c) => ({ id: `c${c.ref}`, name: c.name, system: 'sage', ref: c.ref, isActive: true, stateHash: 'h' })),
  } as never),
}));
vi.mock('@/modules/accounting/services/sage-migration/sageBatchRun', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/sage-migration/sageBatchRun')>()),
  sendBatch: async (_s: unknown, s: Send, _b: unknown, dry: boolean): Promise<BatchReport> => {
    h.sent.push(`${s.entity} ${dry ? 'dry' : 'live'}`);
    const base = { entity: s.entity, n: s.n, size: s.size, key: `k-${s.entity}-${s.n}${dry ? '-dry' : ''}`, allRowsAlreadyPresent: false, rowsAbsent: 0 };
    if (h.fail.has(`${s.entity} ${dry ? 'dry' : 'live'}`)) return { ...base, status: 'failed', toolReported: null, error: 'refused' };
    if (!dry && s.categorySent) h.books.cats.push({ ref: s.categorySent.sageId, name: s.categorySent.name });
    if (!dry && s.itemSent) h.books.items.push(...s.itemSent.map((i) => ({ ref: i.sageId, code: i.code })));
    if (!dry && s.poRefs) for (const r of s.poRefs) h.books.pos.set(r, 11500);
    const toolReported = s.entity === 'category' ? { outcome: 'created', name: s.categorySent?.name }
      : s.entity === 'item' ? { written: true, rows: (s.itemRows ?? []).map((r, index) => ({ index, code: r.code, outcome: h.updated ? 'updated' : 'created', changed: ['description'] })) }
        : { created: 1, purchase_orders: [], counter: { raised: true } };
    return { ...base, status: 'ok', toolReported, error: null };
  },
}));

import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';

const parsed = () => parseSageExport({
  Items: [{ ID: 50, Code: 'FIB-50', Description: 'a', Active: true, Physical: true, Category: { ID: 10, Description: 'Optics' } }],
  PurchaseOrders: [{ ID: 900, DocumentNumber: 'P900', Date: '2026-02-01', Status: 'Pending', SupplierId: 301, Exclusive: 100, Tax: 15, Total: 115,
    Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, Exclusive: 100, Tax: 15 }] }],
});
const pool = { options: { max: 4 } } as never;
const run = (over: Record<string, unknown> = {}) => runSageMigration(pool, parsed(), { companyId: 'c', userId: 'u', live: true, expect: { items: 1, purchaseOrders: 1 }, ...over });

beforeEach(() => { h.books.cats = []; h.books.items = []; h.books.pos = new Map(); h.fail.clear(); h.updated = false; h.sent.length = 0; });

describe('the dry run', () => {
  it('a failed category batch keeps the items and the POs from starting', async () => {
    h.fail.add('category dry');
    const r = await run();
    expect(r.status).toBe('dry_run_failed');
    expect(r.dryRun.items).toMatchObject({ skipped: true, batches: [] });
    expect(r.dryRun.purchaseOrders).toMatchObject({ skipped: true });
    expect(h.sent).toEqual(['category dry']);
  });
  it('a failed item batch keeps the POs from starting', async () => {
    h.fail.add('item dry');
    const r = await run();
    expect(r.dryRun.purchaseOrders).toMatchObject({ skipped: true });
    expect(h.sent).toEqual(['category dry', 'item dry']);
  });
});

describe('the live run', () => {
  it('a clean dry run with nothing to allow goes live: categories, items, POs, in order', async () => {
    const r = await run();
    expect(r.status).toBe('completed');
    expect(h.sent).toEqual(['category dry', 'item dry', 'purchase_order dry', 'category live', 'item live', 'purchase_order live']);
  });
  it('differences the person did not allow block it (liveBlockers); --allow-differences lets it go', async () => {
    h.updated = true; // a re-run: the item is owned, and Sage's values would change it
    h.books.items = [{ ref: '50', code: 'FIB-50' }];
    h.books.cats = [{ ref: '10', name: 'Optics' }];
    const blocked = await run();
    expect(blocked.status).toBe('live_blocked');
    expect(blocked.liveBlockedBy.join(' ')).toMatch(/differ from the books .*--allow-differences/);
    expect(h.sent.filter((x) => x.endsWith('live'))).toEqual([]);
    expect((await run({ allowDifferences: true })).status).toBe('completed');
  });
  it('a failed live category batch keeps the items and POs from starting, and the run is not complete', async () => {
    h.fail.add('category live');
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.live!.items).toMatchObject({ skipped: true });
    expect(r.reconciliation.allSentBooked).toBe(false);
    expect(h.sent.filter((x) => x.endsWith('live'))).toEqual(['category live']);
  });
  it('a failed live batch keeps the run from being complete even when its rows are in the books (failedBatches counts it)', async () => {
    h.books.pos = new Map([['900', 11500]]); // the PO was booked by an earlier run
    h.fail.add('purchase_order live');
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.reconciliation.purchaseOrders.presentAfter).toBe(1);
    expect(r.reconciliation.allSentBooked).toBe(false);
  });
});

describe('B17-3 (round 17): a stop the caller asks for (shouldStop: the CLI\'s SIGINT / SIGTERM)', () => {
  it('asked once the live phase started: the run stops before the next batch, MigrationStopped, what was committed listed', async () => {
    const r = run({ shouldStop: () => (h.sent.includes('category live') ? 'stopped by SIGTERM: no further batch is sent' : null) });
    const err = await r.then(() => null, (e: unknown) => e);
    const { MigrationStopped } = await import('@/modules/accounting/services/sage-migration/sageMigrationStopped');
    expect(err).toBeInstanceOf(MigrationStopped);
    expect((err as InstanceType<typeof MigrationStopped>).message).toMatch(/stopped by SIGTERM/);
    expect((err as InstanceType<typeof MigrationStopped>).committed.map((b) => b.entity)).toEqual(['category']);
    expect(h.sent.filter((x) => x.endsWith('live'))).toEqual(['category live']);
  });
  it('asked between two category batches: the second is never sent (checked before every batch, not only between phases)', async () => {
    const two = parseSageExport({ Items: [
      { ID: 50, Code: 'FIB-50', Description: 'a', Active: true, Physical: true, Category: { ID: 10, Description: 'Optics' } },
      { ID: 51, Code: 'FIB-51', Description: 'b', Active: true, Physical: true, Category: { ID: 11, Description: 'Cable' } },
    ] });
    const err = await runSageMigration(pool, two, { companyId: 'c', userId: 'u', live: true, expect: { items: 2, purchaseOrders: 0 },
      shouldStop: () => (h.sent.includes('category live') ? 'stopped by SIGTERM: no further batch is sent' : null) }).then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/stopped by SIGTERM/);
    expect(h.sent.filter((x) => x.endsWith('live'))).toEqual(['category live']);
  });
  it('asked before the live phase: refused, nothing live sent, not a MigrationStopped', async () => {
    const { MigrationStopped } = await import('@/modules/accounting/services/sage-migration/sageMigrationStopped');
    const err = await run({ shouldStop: () => 'stopped by SIGINT: no further batch is sent' }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(MigrationStopped);
    expect(String(err)).toMatch(/stopped by SIGINT/);
    expect(h.sent.filter((x) => x.endsWith('live'))).toEqual([]);
  });
});

describe('round 18: dry-run stops, no stop after the last batch, progress', () => {
  it('B18-3: asked in the dry run: StopRequested before the next dry batch, nothing live sent', async () => {
    const { StopRequested } = await import('@/modules/accounting/services/sage-migration/sageMigrationRunner');
    const err = await run({ shouldStop: () => (h.sent.includes('category dry') ? 'stopped by SIGTERM: no further batch is sent' : null) }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StopRequested);
    expect(h.sent).toEqual(['category dry']);
  });
  it('R18-6: asked after the last live batch: the run is not stopped, it completes with its reconciliation', async () => {
    const r = await run({ shouldStop: () => (h.sent.includes('purchase_order live') ? 'stopped by SIGTERM: no further batch is sent' : null) });
    expect(r.status).toBe('completed');
    expect(r.live).not.toBeNull();
  });
  it('onProgress: the dry phase, its batches, the live phase, each live batch sending then recorded', async () => {
    const seen: string[] = [];
    await run({ onProgress: (p: { kind: string; phase?: string; batch?: { entity: string } }) => {
      seen.push(p.kind === 'phase' ? `phase ${p.phase}` : `${p.kind}${p.kind === 'recorded' ? ` ${p.phase}` : ''} ${p.batch!.entity}`);
    } });
    expect(seen).toEqual(['phase dry', 'recorded dry category', 'recorded dry item', 'recorded dry purchase_order', 'phase live',
      'sending category', 'recorded live category', 'sending item', 'recorded live item', 'sending purchase_order', 'recorded live purchase_order']);
  });
});

describe('R19-1: a stop before the live phase', () => {
  it('is a refused start: no "phase live" event, nothing live sent', async () => {
    const { StopRequested } = await import('@/modules/accounting/services/sage-migration/sageMigrationRunner');
    const phases: string[] = [];
    const err = await run({
      shouldStop: () => (h.sent.includes('purchase_order dry') ? 'stopped by SIGTERM: no further batch is sent' : null),
      onProgress: (p: { kind: string; phase?: string }) => { if (p.kind === 'phase') phases.push(p.phase!); },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StopRequested);
    expect(phases).toEqual(['dry']);
    expect(h.sent.filter((x) => x.endsWith('live'))).toEqual([]);
  });
});

