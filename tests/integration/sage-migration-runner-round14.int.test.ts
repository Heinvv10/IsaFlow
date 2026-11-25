/**
 * Round-11 breaker findings on a real database (b11-a probes B11-A1, B11-A3 and the legit multi-page export, ported), and review R3:
 *   - B11-1: a whole export in Sage's own pages ($next on every page but the last) runs, dry and live;
 *   - B11-2: an item batch that COMMITTED and then failed the check against the books (a writer changed one of its rows) says the owned
 *     item "was updated ..., then changed in the books since", not "not in the books" (the overwrite happened);
 *   - B11-3: a stop names the owned rows its committed batches overwrote (a dry run after it no longer shows them), and what an unconfirmed
 *     batch may have updated;
 *   - R3: a batch refused before the stop is listed "failed, nothing written" with its reason.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, failingBatchPool, failingCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import type { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor, summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const opts = (over: Row = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });
const run = (over: Row = {}, p: Pool = pool, file: Row = exportFile()) => runSageMigration(p, parsedExport(file), opts(over));
const stopped = (p: Promise<unknown>) => p.then(() => { throw new Error('the run did not stop'); }, (e: unknown) => e as MigrationStopped);
const desc = async (ref: string) => (await pool.query(`SELECT description FROM items WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref])).rows[0]?.description;
const catName = async (ref: string) => (await pool.query(`SELECT name FROM item_categories WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref])).rows[0]?.name;
const edit = (ref: string) => pool.query(`UPDATE items SET description = 'edited', updated_at = now() WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref]);
const editCat = (ref: string) => pool.query(`UPDATE item_categories SET name = name || ' edited', updated_at = now() WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref]);

/** The fixture as Sage pages it: $next on every page but the last, $back on every page but the first, the totals and $startIndex right. */
function inSagePages(f: Row): Row {
  const U = 'https://accounting.sageone.co.za/api/2.0.0/Get?$top=';
  const paged = (rows: Row[], per: number): Row[] => {
    const pages: Row[] = [];
    for (let i = 0; i < rows.length; i += per) {
      const last = i + per >= rows.length;
      pages.push({ $totalResults: rows.length, $startIndex: i, $itemsPerPage: per, ...(last ? {} : { $next: `${U}${per}&$skip=${i + per}` }), ...(i === 0 ? {} : { $back: `${U}${per}&$skip=${i - per}` }), $resources: rows.slice(i, i + per) });
    }
    return pages;
  };
  return { Items: paged((f.Items as { $resources: Row[] }).$resources, 10), PurchaseOrders: paged(f.PurchaseOrders as Row[], 4) };
}

describe('B11-1: a whole export in Sage\'s pages', () => {
  it('is read whole: the dry run is clean and the live run books it all, as the one-page file does', async () => {
    const f = inSagePages(exportFile());
    expect(((f.PurchaseOrders as Row[])[0] as Row).$next).toBeDefined();
    const dry = await run({ live: false }, pool, f);
    expect(dry.status).toBe('dry_run_ok');
    expect(dry.reconciliation.items.sent + dry.reconciliation.purchaseOrders.sent).toBe(30);
    const live = await run({ allowRefusals: false, allowDifferences: false }, pool, f);
    expect(live.status).toBe('completed');
    expect(exitCodeFor(live, false, false)).toBe(0);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, categories: 4, pos: 10 });
  });
});

describe('B11-2 (B11-A1): an item batch that committed, then failed the check against the books', () => {
  it('the overwritten item reads "was updated ..., then changed in the books since (check)"; the edit is gone', async () => {
    expect((await run()).status).toBe('completed');
    await edit('50002');
    const hooked = afterCommitOf(pool, 'bulk_upsert_items', {
      after: async () => { await pool.query(`UPDATE items SET is_active = false WHERE company_id = $1 AND external_ref = '50003'`, [s.companyId]); },
    });
    const r = await run({}, hooked);
    expect(r.status).toBe('failed');
    expect(r.live!.items.batches[0]).toMatchObject({ status: 'failed', changedAfterCommit: true });
    expect(summaryLines(r).find((l) => /item FIB-0002/.test(l))).toBe("DIFFERS: item FIB-0002 was updated to Sage's values, then changed in the books since (check): description");
    expect(await desc('50002')).not.toBe('edited');
  });
});

describe('B11-3 (B11-A3): a COMMIT that fails on item batch 2 of 2, on a re-run with edits', () => {
  it('the stop names what the committed batches overwrote and what the unconfirmed one may have; a dry run after it cannot', async () => {
    expect((await run()).status).toBe('completed');
    await edit('50002'); await edit('50016'); await editCat('13');
    // Commits: 1-4 categories, 5 item batch 1 (FIB-0001..0010), 6 item batch 2 (FIB-0011..)
    const err = await stopped(run({ itemBatchSize: 10 }, failingCommitPool(pool, [6])));
    const m = stopMessage(err);
    expect(exitCodeForError(err)).toBe(4);
    expect(m).toMatch(/committed: category batch \d \(.*\)\n {2}was updated to Sage's values \(an IsaFlow edit of these fields was overwritten\): category Tools \(name\)/);
    expect(m).toMatch(/committed: item batch 1 \(.*\)\n {2}was updated to Sage's values \(an IsaFlow edit of these fields was overwritten\): item FIB-0002 \(description\)/);
    expect(m).toMatch(/commit unconfirmed: item batch 2 \(.*\)\n {2}may have been updated to Sage's values \(check the books\): item FIB-0016 \(description\)/);
    expect([await desc('50002'), await desc('50016'), await catName('13')]).toEqual(['Fibre stock item 2', 'edited', 'Tools']);
    // why the stop must say it: the dry run the message points to sees FIB-0002 and Tools as Sage's already
    const after = summaryLines(await run({ itemBatchSize: 10, live: false })).filter((l) => l.startsWith('DIFFERS'));
    expect(after.join('\n')).not.toMatch(/FIB-0002|Tools/);
    expect((await run({ itemBatchSize: 10 })).status).toBe('completed');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, categories: 4, pos: 10 });
  });
});

describe('R3: a batch refused before the stop', () => {
  it('is listed "failed, nothing written" with its reason, beside the unconfirmed one', async () => {
    // Item batch 1 fails before its COMMIT (nothing written, no COMMIT sent); item batch 2's COMMIT (the 5th) does not answer.
    const err = await stopped(run({ itemBatchSize: 10 }, failingCommitPool(failingBatchPool(pool, 'sage-mig-item-0001-'), [5])));
    const m = stopMessage(err);
    expect(exitCodeForError(err)).toBe(4);
    expect(err.batches.failed.map((b) => [b.entity, b.n])).toEqual([['item', 1]]);
    expect(m).toMatch(/commit unconfirmed: item batch 2 \(/);
    expect(m).toMatch(/\nfailed, nothing written: item batch 1 \(sage-mig-item-0001-[0-9a-f]+\): injected: batch sage-mig-item-0001- failed$/);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 4, items: 0, pos: 0 });
  });
});
