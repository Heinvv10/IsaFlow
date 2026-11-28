/**
 * Round-9 review findings on a real database:
 *   - L2: a phase that never started is "not run" in the summary;
 *   - L3: every live phase's batches are checked against the books, a failed sibling or not (a replay whose rows are gone reads failed);
 *   - L4: a COMMIT that never answers is bounded and is a commitUnconfirmed batch that stops the run (round 10), not a hung run;
 *   - L5: the runner itself refuses --live without expect.items and expect.purchaseOrders.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, cleanupSageWorld, exportFile, failingBatchPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { setCommitBoundForTests } from '@/modules/accounting/services/sage-migration/sageToolSession';
import { summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const run = (over: Record<string, unknown> = {}, p: Pool = pool) =>
  runSageMigration(p, parsedExport(exportFile()), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });

describe('L2: a phase that never started', () => {
  it('a failed category batch: the items and PO phases read "not run" in the summary, not "0 batches, 0 failed"', async () => {
    // Category batch 1 is renamed right after it committed: it fails the check against the books, and the items do not start.
    const r = await run({}, afterCommitOf(pool, 'upsert_item_category', {
      after: async () => { await pool.query(`UPDATE item_categories SET name = name || ' X' WHERE company_id = $1`, [s.companyId]); },
    }));
    expect(r.status).toBe('failed');
    expect(summaryLines(r).join('\n')).toMatch(/live: categories: 4 batches, 1 failed; items: not run; purchase orders: not run/);
    expect(summaryLines(r).join('\n')).toMatch(/dry run: categories: 4 batches, 0 failed; items: 1 batches, 0 failed; purchase orders: 1 batches, 0 failed/);
  });
});

describe('L3: a failed sibling does not skip the rows-present check of the others', () => {
  it('categories replayed with their rows gone, one batch failing: the others read "replayed, rows absent", not ok', async () => {
    expect((await run({ live: true })).status).toBe('completed');
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [s.companyId]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM items WHERE company_id = $1', [s.companyId]);
    await pool.query('DELETE FROM item_categories WHERE company_id = $1', [s.companyId]);
    const r = await run({}, failingBatchPool(pool, 'sage-mig-category-0001-')); // category batch 1 fails; 2-4 answer from their stored answers
    const cats = r.live!.categories.batches;
    expect(cats[0]!.error).toMatch(/injected: batch sage-mig-category-0001- failed/);
    expect(cats.slice(1).map((b) => [b.status, b.rowsAbsent])).toEqual([['failed', 1], ['failed', 1], ['failed', 1]]);
    expect(cats[1]!.error).toMatch(/replayed, rows absent/);
  });
});

describe('L4: a COMMIT that never answers', () => {
  it('is bounded: the batch is listed failed and commitUnconfirmed, and the run stops instead of hanging', async () => {
    const restore = setCommitBoundForTests(400);
    let commits = 0;
    const hanging = {
      options: pool.options,
      connect: async () => {
        const c = await pool.connect();
        return new Proxy(c, {
          get(t, p) {
            if (p === 'query') return (...a: unknown[]) => (a[0] === 'COMMIT' && ++commits === 5 ? new Promise(() => undefined) : (t.query as (...x: unknown[]) => Promise<unknown>)(...a)); // 4 categories, then the item batch
            const v = Reflect.get(t, p, t) as unknown;
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    } as unknown as Pool;
    try {
      const r = await Promise.race([run({}, hanging).then(() => 'NOT STOPPED', (e: unknown) => e), new Promise<string>((res) => setTimeout(() => res('HUNG'), 30_000))]);
      expect(r).toBeInstanceOf(MigrationStopped);
      const item = (r as MigrationStopped).committed.find((b) => b.entity === 'item')!;
      expect(item.status).toBe('failed');
      expect(item.commitUnconfirmed).toBe(true);
      expect(item.error).toMatch(/COMMIT did not answer within 400/);
    } finally { restore(); }
  }, 60_000);
});

describe('L5: the runner refuses a live run without figures to check', () => {
  const live = (expectOpt: Record<string, unknown> | undefined) => runSageMigration(pool, parsedExport(exportFile()), { companyId: s.companyId, userId: s.userId, live: true, expect: expectOpt as never });
  it('no expect, or only one of the two counts: it throws before touching anything', async () => {
    for (const e of [undefined, {}, { items: 20 }, { purchaseOrders: 10 }, { purchaseOrderTotalCents: 1 }]) {
      await expect(live(e), JSON.stringify(e)).rejects.toThrow(/live run needs expect\.items and expect\.purchaseOrders/);
    }
    expect((await pool.query('SELECT count(*)::INT AS n FROM items WHERE company_id = $1', [s.companyId])).rows[0].n).toBe(0);
  });
  it('a dry run needs none, and a live run with both goes ahead', async () => {
    expect((await runSageMigration(pool, parsedExport(exportFile()), { companyId: s.companyId, userId: s.userId, live: false })).status).toBe('dry_run_ok');
    expect((await live({ items: 20, purchaseOrders: 10 })).status).toBe('completed');
  });
});
