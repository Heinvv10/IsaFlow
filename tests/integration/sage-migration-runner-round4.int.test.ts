/**
 * Round-4 findings on a real database:
 *   - M1: an owned CATEGORY changed in IsaFlow (renamed, deactivated) is put back by the re-run exactly as the dry run said: its batch key
 *     follows its state, so live is not a replay that writes nothing and leaves the items to fail on a name that is gone; the change is in
 *     differences.categories; after the categories phase the books are checked against what was sent;
 *   - L3: an error after the live phase started carries what was committed; one before does not claim a commit;
 *   - L5: the state hash does not depend on the session's TimeZone or DateStyle.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { sql } from '@/lib/neon';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { readSnapshot } from '@/modules/accounting/services/sage-migration/sageSnapshot';
import { withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';
import { summaryLines } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

const run = (over: Record<string, unknown> = {}, p: Pool = pool) =>
  runSageMigration(p, parsedExport(exportFile()), { companyId: s.companyId, userId: s.userId, live: true, liveWithoutCounts: true, allowRefusals: true, allowDifferences: true, ...over });
const category = async (ref: string) => (await pool.query('SELECT name, is_active FROM item_categories WHERE company_id = $1 AND external_ref = $2', [s.companyId, ref])).rows[0] as { name: string; is_active: boolean };

describe('M1: an owned category changed in IsaFlow', () => {
  it('renamed: the dry run names it, live puts the name back, the items then import (no category_not_found cascade)', async () => {
    await run();
    await pool.query(`UPDATE item_categories SET name = 'Optics RENAMED' WHERE company_id = $1 AND external_ref = '10'`, [s.companyId]);
    const dry = await run({ live: false });
    expect(dry.differences.categories).toEqual([{ name: 'Optics', changed: ['name'] }]);
    const blocked = await run({ allowDifferences: false });
    expect(blocked.status).toBe('live_blocked');
    expect((await category('10')).name).toBe('Optics RENAMED'); // nothing written
    const r = await run();
    expect(r.status).toBe('completed');
    expect(await category('10')).toEqual({ name: 'Optics', is_active: true });
    expect(r.differences.categories).toEqual([{ name: 'Optics', changed: ['name'] }]);
    expect(r.live!.items.batches.every((b) => b.status === 'ok')).toBe(true);
    expect(summaryLines(dry).join('\n')).toMatch(/DIFFERS: category Optics would be updated to Sage's values: name/);
    expect(summaryLines(r).join('\n')).toMatch(/DIFFERS: category Optics was updated to Sage's values \(an IsaFlow edit of these fields was overwritten\): name/); // a live run: it WAS
  });

  it('deactivated: live reactivates it', async () => {
    await run();
    await pool.query(`UPDATE item_categories SET is_active = false WHERE company_id = $1 AND external_ref = '11'`, [s.companyId]);
    const r = await run();
    expect(r.status).toBe('completed');
    expect((await category('11')).is_active).toBe(true);
    expect(r.differences.categories).toEqual([{ name: 'Poles and Hardware', changed: ['is_active'] }]);
  });

  it('a re-run when nothing changed in IsaFlow: no category difference, no row touched', async () => {
    await run();
    const stamp = async () => (await pool.query(`SELECT string_agg(id::TEXT || xmin::TEXT, ',' ORDER BY id) AS s FROM item_categories WHERE company_id = $1`, [s.companyId])).rows[0].s;
    const before = await stamp();
    const r = await run();
    expect(r.differences.categories).toEqual([]);
    expect(await stamp()).toBe(before);
  });

  it('a category changed right after its batch committed: the batch is failed naming it and the items phase is not started', async () => {
    const hooked = afterCommitOf(pool, 'upsert_item_category', {
      after: async () => { await pool.query(`UPDATE item_categories SET name = name || ' X' WHERE company_id = $1 AND external_ref = '10'`, [s.companyId]); },
    });
    const r = await run({}, hooked);
    expect(r.status).toBe('failed');
    const bad = r.live!.categories.batches.filter((b) => b.status === 'failed');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.error).toMatch(/not what this batch sent.*Optics.*name is "Optics X", sent "Optics".*items phase is not started/s);
    expect(r.live!.items.batches).toEqual([]);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, pos: 0 });
  });
});

describe('L3: what an error says about the commit', () => {
  it('after the live phase started, the error carries what was committed, and the message says the run may have committed', async () => {
    const hooked = afterCommitOf(pool, 'bulk_upsert_items', { failNextConnect: true });
    const err = await run({}, hooked).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationStopped);
    const stopped = err as MigrationStopped;
    expect(stopped.liveStarted).toBe(true);
    expect(stopped.message).toMatch(/injected: connection lost/);
    expect(stopped.committed.map((b) => [b.entity, b.n, b.status])).toEqual([
      ['category', 1, 'ok'], ['category', 2, 'ok'], ['category', 3, 'ok'], ['category', 4, 'ok'], ['item', 1, 'ok'],
    ]);
    const text = stopMessage(err);
    expect(text).toMatch(/the live run may already have committed/);
    expect(text).toMatch(/committed: category batch 1 [\s\S]*committed: category batch 4 [\s\S]*committed: item batch 1/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, categories: 4, pos: 0 });
  });

  it('before the live phase (not a member, a bad account, a dry-run throw) the error is the plain one and claims no commit', async () => {
    const notMember = await run({ userId: s.otherUserId }).then(() => null, (e: unknown) => e);
    expect(notMember).not.toBeInstanceOf(MigrationStopped);
    expect(stopMessage(notMember)).not.toMatch(/commit/);
    const failDry = { options: pool.options, connect: async () => { throw new Error('injected: no database'); } } as unknown as Pool;
    const e = await run({}, failDry).then(() => null, (x: unknown) => x);
    expect(e).not.toBeInstanceOf(MigrationStopped);
    expect(stopMessage(e)).toBe('sage migration stopped: no connection to the database could be had (injected: no database): nothing was sent, so nothing of it was written'); // B26-1
  });
});

describe('L5: the item and category state hashes do not depend on the session TimeZone or DateStyle', () => {
  const hashes = (tz: string, style: string) => withToolSession(pool, s.companyId, s.userId, false, async () => {
    await sql`SELECT set_config('TimeZone', ${tz}, true), set_config('DateStyle', ${style}, true)`;
    const snap = await readSnapshot(s.companyId);
    return { items: snap.items.map((i) => i.stateHash), categories: snap.categories.map((c) => c.stateHash) };
  });
  it('the same rows hash the same under UTC / ISO, Pacific/Auckland / SQL DMY and Africa/Johannesburg / German', async () => {
    await run();
    const a = await hashes('UTC', 'ISO, MDY');
    const b = await hashes('Pacific/Auckland', 'SQL, DMY');
    const c = await hashes('Africa/Johannesburg', 'German, DMY');
    expect(a.items.length).toBe(20);
    expect(a.categories.length).toBe(4);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
