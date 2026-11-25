/**
 * Round-10 review + breaker findings on a real database (b10-a probes B10-A1, B10-A2, B10-A3 ported):
 *   - MED / B10-1: the summary says an owned item or category "was updated" only when its live batch is ok: a category batch that failed
 *     the check against the books keeps the items from running, and neither the category nor the item reads "was updated";
 *   - L2: the first batch whose COMMIT does not answer STOPS the run, in any phase (MigrationStopped, exit 4, the batch listed as
 *     "commit unconfirmed"): no later batch is sent against books that may not hold it yet. A COMMIT that lands after the bound is found
 *     by the re-run, with no duplicate;
 *   - L7: the runner's phase skipping is held by tests that go red when it is mutated: verifiedCategories by round4's "a category changed
 *     right after its batch committed" and B10-A2 here; the live skippedPhase by round11 L2 and B10-A2; the dry run's by the last one here.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, failingCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { setCommitBoundForTests } from '@/modules/accounting/services/sage-migration/sageToolSession';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const opts = (over: Row = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });
const run = (over: Row = {}, p: Pool = pool) => runSageMigration(p, parsedExport(exportFile()), opts(over));
const stopped = (p: Promise<unknown>) => p.then(() => { throw new Error('the run did not stop'); }, (e: unknown) => e as MigrationStopped);
const desc = async (ref: string) => (await pool.query(`SELECT description FROM items WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref])).rows[0]?.description;
const editItem = () => pool.query(`UPDATE items SET description = 'edited', updated_at = now() WHERE company_id = $1 AND external_ref = '50002'`, [s.companyId]);

describe('B10-A2 / MED: a category batch that fails its check against the books', () => {
  it('items not run: the item reads "would be updated (not written ...)", the failed category is not "was updated"; exit 1, the edit kept', async () => {
    expect((await run()).status).toBe('completed');
    await editItem();
    await pool.query(`UPDATE item_categories SET name = 'Optics edited', updated_at = now() WHERE company_id = $1 AND external_ref = '10'`, [s.companyId]);
    // Renamed again right after the live category batch committed: the books do not hold what it sent, so it fails and the items do not run.
    const hooked = afterCommitOf(pool, 'upsert_item_category', {
      after: async () => { await pool.query(`UPDATE item_categories SET name = 'Optics (renamed)' WHERE company_id = $1 AND external_ref = '10'`, [s.companyId]); },
    });
    const r = await run({}, hooked);
    const lines = summaryLines(r);
    expect(r.status).toBe('failed');
    expect(exitCodeFor(r, true, true)).toBe(1);
    expect(lines.find((l) => l.startsWith('live:'))).toMatch(/items: not run; purchase orders: not run/);
    expect(lines.find((l) => /item FIB-0002/.test(l))).toBe("DIFFERS: item FIB-0002 would be updated to Sage's values (not written: the items phase did not run): description");
    expect(lines.find((l) => /category Optics/.test(l))).toMatch(/^DIFFERS: category Optics would be updated to Sage's values \(not in the books: category batch \d+ failed\)/);
    expect(lines.join('\n')).not.toMatch(/was updated|was overwritten/);
    expect(await desc('50002')).toBe('edited');
  });
});

describe('B10-A1 / L2: a category COMMIT that does not answer', () => {
  it('stops the run at that batch (exit 4): no later category or item batch is sent, the batch is listed, nothing says "was updated"', async () => {
    expect((await run()).status).toBe('completed');
    await editItem();
    const calls = async () => Number((await pool.query(`SELECT count(*) AS n FROM mcp_tool_calls WHERE company_id = $1`, [s.companyId])).rows[0].n);
    const before = await calls();
    const err = await stopped(run({}, failingCommitPool(pool, [1])));
    expect(err).toBeInstanceOf(MigrationStopped);
    expect(exitCodeForError(err)).toBe(4);
    expect(err.message).toMatch(/the COMMIT of category batch 1 \(sage-mig-category-0001-[0-9a-f]+\) did not answer \(injected: COMMIT 1 failed\): it may still land, so no further batch is sent/);
    expect(err.committed.map((b) => [b.entity, b.n, b.commitUnconfirmed === true])).toEqual([['category', 1, true]]);
    const message = stopMessage(err);
    expect(message).toMatch(/commit unconfirmed: category batch 1 \(/);
    expect(message).not.toMatch(/was updated|was overwritten/);
    expect(await desc('50002')).toBe('edited');
    expect(await calls()).toBe(before); // the injected failure rolled batch 1 back, and nothing after it was sent
  });
});

describe('L2: a PO COMMIT that does not answer', () => {
  it('stops the run there: the later PO batches are not sent (their budget check would read books that may lack batch 1)', async () => {
    // Commits: 1-4 categories, 5 the item batch, 6-9 the PO batches of 3.
    const err = await stopped(run({ poBatchSize: 3 }, failingCommitPool(pool, [6])));
    expect(exitCodeForError(err)).toBe(4);
    expect(err.committed.filter((b) => b.entity === 'purchase_order').map((b) => [b.n, b.commitUnconfirmed === true])).toEqual([[1, true]]);
    expect(stopMessage(err)).toMatch(/committed: item batch 1 \(.*\ncommit unconfirmed: purchase_order batch 1 \(/s);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 20, pos: 0 });
  });
});

describe('B10-A3 / L2: a COMMIT that lands after the bound', () => {
  it('stops the run with the batch unconfirmed while its rows ARE in the books; a strict re-run completes with no duplicate', async () => {
    const restore = setCommitBoundForTests(300);
    let commits = 0;
    // The 6th COMMIT (PO batch 1) reaches the server and lands; its answer is held past the bound.
    const slow = {
      options: pool.options,
      connect: async () => {
        const c = await pool.connect();
        return new Proxy(c, {
          get(t, p) {
            if (p === 'query') {
              return async (...a: unknown[]) => {
                const out = await (t.query as (...x: unknown[]) => Promise<unknown>)(...a);
                if (a[0] === 'COMMIT' && ++commits === 6) await new Promise((res) => setTimeout(res, 900));
                return out;
              };
            }
            const v = Reflect.get(t, p, t) as unknown;
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    } as unknown as Pool;
    try {
      const err = await stopped(run({ poBatchSize: 3 }, slow));
      expect(exitCodeForError(err)).toBe(4);
      expect(err.message).toMatch(/the COMMIT of purchase_order batch 1 .* did not answer \(COMMIT did not answer within 300ms\)/);
      expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 3 }); // batch 1 landed, batches 2-4 were never sent
    } finally { restore(); }
    const again = await run({ poBatchSize: 3, allowRefusals: false, allowDifferences: false });
    expect(again.status).toBe('completed');
    expect(exitCodeFor(again, false, false)).toBe(0);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, pos: 10 });
  }, 60_000);
});

describe('L7 (round 10): a dry run whose category batches fail', () => {
  it('reads "not run" for the items and the POs, not "0 batches", and nothing is written', async () => {
    // A writer lands between the snapshot and the dry run: the names of the export's categories, taken by categories the migration does
    // not own, just as the dry run's first category batch asks its idempotency lock. The tool refuses each batch; the plan could not know.
    const names = parsedExport(exportFile()).categories.map((c) => c.description);
    let raced = false;
    const racing = {
      options: pool.options,
      connect: async () => {
        const c = await pool.connect();
        return new Proxy(c, {
          get(t, p) {
            if (p === 'query') {
              return async (...a: unknown[]) => {
                if (!raced && Array.isArray(a[1]) && a[1].some((x) => typeof x === 'string' && x.includes(':sage-mig-category-0001-') && x.endsWith('-dry'))) {
                  raced = true;
                  for (const name of names) await pool.query(`INSERT INTO item_categories (company_id, name) VALUES ($1, $2)`, [s.companyId, name]);
                }
                return (t.query as (...x: unknown[]) => Promise<unknown>)(...a);
              };
            }
            const v = Reflect.get(t, p, t) as unknown;
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    } as unknown as Pool;
    const r = await run({}, racing);
    expect(raced).toBe(true);
    expect(r.status).toBe('dry_run_failed');
    expect(r.live).toBeNull();
    expect(summaryLines(r).join('\n')).toContain(`dry run: categories: ${names.length} batches, ${names.length} failed; items: not run; purchase orders: not run`);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: names.length, items: 0, pos: 0 }); // only the writer's own rows
  });
});
