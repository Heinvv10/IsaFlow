/**
 * #1655: the same-name cases of a merged-away supplier. Merged-away aliases of one name (same or different
 * survivors), a survivor or a chain row already claimed by another Sage party, another system's ref, the order of
 * bills and suppliers, and a claim lost to a concurrent import. The basic merge-and-follow cases are in
 * i1655-sage-merged-supplier.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { als } from '@/lib/als';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { resolveSageSupplier } from '@/modules/admin/services/sagePartyMatch';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { party, sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('aliases');
const { pool, companyId, userId, inRequestTx, syncSuppliers, byRef, liveNamed, insPlain, bill, billSupplier } = w;

beforeAll(() => w.seed(), 60000);
afterAll(() => w.drop(), 60000);

describe('merged-away suppliers of one name (#1655)', () => {
  it('merged-away rows of one name leading to different survivors are ambiguous: each Sage party gets its own row', async () => {
    const [s1, s2] = [await insPlain('Pine Co Survivor One'), await insPlain('Pine Co Survivor Two')];
    const [g1, g2] = [await insPlain('Pine Co'), await insPlain('Pine Co')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [g1, s1]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [g2, s2]);
    // Creation order does not pick a survivor: neither merged-away row is matched or stamped.
    await expect(bill('AP-PINE-1', 'Pine Co', 941)).rejects.toThrow('Supplier not found: Pine Co');
    expect((await syncSuppliers([party(941, 'Pine Co'), party(942, 'Pine Co')])).suppliers)
      .toEqual({ created: 2, skipped: 0, failed: [] });
    for (const ref of ['941', '942']) {
      expect(await byRef(ref)).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    }
    const { rows } = await pool.query('SELECT external_ref FROM suppliers WHERE id = ANY($1)', [[g1, g2]]);
    expect(rows).toEqual([{ external_ref: null }, { external_ref: null }]);
    // Re-syncing finds each by its own id and creates nothing.
    expect((await syncSuppliers([party(941, 'Pine Co'), party(942, 'Pine Co')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
  });

  it('merged-away rows of one name leading to the SAME survivor are no ambiguity', async () => {
    const survivor = await insPlain('Larch Co Survivor');
    const [g1, g2] = [await insPlain('Larch Co'), await insPlain('Larch Co')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = ANY($1)', [[g1, g2], survivor]);
    expect((await bill('AP-LARCH-1', 'Larch Co', 945)).created).toBe(true);
    expect(await billSupplier('AP-LARCH-1')).toBe(survivor);
  });

  it('a second Sage party cannot claim the other unstamped alias of a survivor the first already claimed by name', async () => {
    const survivor = await insPlain('Spruce Co Survivor');
    const [g1, g2] = [await insPlain('Spruce Co'), await insPlain('Spruce Co')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = ANY($1)', [[g1, g2], survivor]);
    // Sage party 947 reaches the survivor by name and claims one alias.
    expect((await syncSuppliers([party(947, 'Spruce Co')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    // A different Sage party of that name does not take the remaining alias: it gets its own live row.
    expect((await syncSuppliers([party(948, 'Spruce Co')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect(await byRef('948')).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    expect((await byRef('947')).map((r) => r.merged_into_id)).toEqual([survivor]);
    // Re-syncing both creates nothing more.
    expect((await syncSuppliers([party(947, 'Spruce Co'), party(948, 'Spruce Co')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
  });

  it('a merged-away supplier stored with a trailing space still matches by its name', async () => {
    const survivor = await insPlain('Fir Co Survivor');
    const gone = await insPlain('Fir Co ');
    // As a merge leaves it: the name is untouched, the row is told by merged_into_id.
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
    expect((await syncSuppliers([party(949, 'Fir Co')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await byRef('949')).toEqual([{ id: gone, deleted: true, merged_into_id: survivor }]);
  });

  it('a claim lost to a concurrent import matches again: two Sage parties never share one row', async () => {
    const live = await insPlain('Birch Co');
    // Import 1 claims the unstamped live row for Sage id 991 and holds its transaction open.
    const holder = await pool.connect();
    const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    try {
      await holder.query('BEGIN');
      const first = await als.run({ client: holder, userId, companyId, claims: {} } as never,
        () => resolveSageSupplier(companyId, { name: 'Birch Co', sageId: 991 }));
      expect(first?.id).toBe(live);
      // Import 2 (Sage id 992, same name) matched the same row; its claim waits on import 1's lock.
      const second = syncSuppliers([party(992, 'Birch Co')]);
      // Wait until import 2 is blocked on that row lock, so the claim it makes is the one that loses. Only this
      // suite's own sessions count (its application_name), never the holder's, and never another suite's waiter.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND application_name = $1 AND pid <> pg_backend_pid()
              AND pid <> $2
              AND query ILIKE '%UPDATE suppliers SET external_system%'`, [w.applicationName, holderPid]);
        blocked = rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query('COMMIT');
      expect((await second).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
      // Without an observed block the claim never raced, and the rest of this test would prove nothing.
      expect(blocked).toBe(true);
    } finally {
      // On the error path the holder may still be inside its transaction: roll it back before it returns to the pool.
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect((await byRef('991')).map((r) => r.id)).toEqual([live]);
    const own = await byRef('992');
    expect(own).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    expect(own[0].id).not.toBe(live);
  });

  it('a merged-away row carrying another system\'s ref is not matched by name, so a Sage party of that name is created', async () => {
    const survivor = await insPlain('Ash Traders Survivor');
    const gone = await insPlain('Ash Traders', 'xero', 'X-1');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
    expect((await syncSuppliers([party(961, 'Ash Traders')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Ash Traders')).map((r) => r.external_ref)).toEqual(['961']);
    // The xero row is untouched; a live row of that name with another system's ref still matches by name.
    const { rows } = await pool.query('SELECT external_system, external_ref FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0]).toEqual({ external_system: 'xero', external_ref: 'X-1' });
    const live = await insPlain('Cedar Works', 'xero', 'X-2');
    expect((await syncSuppliers([party(962, 'Cedar Works')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await pool.query('SELECT external_ref FROM suppliers WHERE id = $1', [live])).rows[0].external_ref).toBe('X-2');
  });

  it('a bill for an unstamped merged-away supplier stamps it like the sync does, so the order of bills and suppliers does not matter', async () => {
    const mk = async (base: string) => {
      const survivor = await insPlain(`${base} Survivor`);
      const gone = await insPlain(base);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
      return { survivor, gone };
    };
    // Bills first, then the suppliers.
    const fir = await mk('Fir Mills');
    expect((await bill('AP-FIR-1', 'Fir Mills', 951)).created).toBe(true);
    expect(await billSupplier('AP-FIR-1')).toBe(fir.survivor);
    expect((await byRef('951')).map((r) => r.id)).toEqual([fir.gone]);
    expect((await syncSuppliers([party(951, 'Fir Mills'), party(952, 'Fir Mills')])).suppliers).toEqual({ created: 1, skipped: 1, failed: [] });
    expect((await liveNamed('Fir Mills')).map((r) => r.external_ref)).toEqual(['952']);
    // Suppliers first, then the bills.
    const yew = await mk('Yew Mills');
    expect((await syncSuppliers([party(971, 'Yew Mills'), party(972, 'Yew Mills')])).suppliers).toEqual({ created: 1, skipped: 1, failed: [] });
    expect((await bill('AP-YEW-1', 'Yew Mills', 971)).created).toBe(true);
    expect((await bill('AP-YEW-2', 'Yew Mills', 972)).created).toBe(true);
    expect(await billSupplier('AP-YEW-1')).toBe(yew.survivor);
    expect(await billSupplier('AP-YEW-2')).toBe(String((await liveNamed('Yew Mills'))[0].id));
  });

  it('two hand-keyed same-name suppliers merged: Sage 101 claims the survivor, Sage 102 gets its own row, bills follow their own party', async () => {
    const keep = await insPlain('Acme Foods');
    const dup = await insPlain('Acme Foods');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', keep, dup, userId));
    expect((await syncSuppliers([party(101, 'Acme Foods')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await byRef('101')).map((r) => r.id)).toEqual([keep]);
    // 102 would match the unstamped merged-away twin by name and follow it to the survivor 101 holds.
    expect((await syncSuppliers([party(102, 'Acme Foods')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    const own = await byRef('102');
    expect(own).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    expect(own[0].id).not.toBe(keep);
    // Re-syncing both creates nothing, and each stays on its own row.
    expect((await syncSuppliers([party(101, 'Acme Foods'), party(102, 'Acme Foods')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect((await byRef('101')).map((r) => r.id)).toEqual([keep]);
    expect((await byRef('102')).map((r) => r.id)).toEqual([own[0].id]);
    // Bills: 102's land on 102's row, 101's on the survivor.
    expect((await bill('AP-ACME-102', 'Acme Foods', 102)).created).toBe(true);
    expect((await bill('AP-ACME-101', 'Acme Foods', 101)).created).toBe(true);
    expect(await billSupplier('AP-ACME-102')).toBe(own[0].id);
    expect(await billSupplier('AP-ACME-101')).toBe(keep);
  });

  it('the survivor test holds at every point of the chain: a stamped row in the middle also refuses a name-only match', async () => {
    // H (hand-keyed 'Acme Bolts') merged into M, a Sage 301 supplier, itself merged into the live C.
    const c = await insPlain('Acme Bolts Holdings');
    const m = await insPlain('Acme Bolts Ltd', 'sage', '301');
    const h = await insPlain('Acme Bolts');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [m, c]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [h, m]);
    expect((await syncSuppliers([party(302, 'Acme Bolts')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await byRef('302'))[0].deleted).toBe(false);
    // Sage 301 still follows its own merge by id.
    expect((await syncSuppliers([party(301, 'Acme Bolts Ltd')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
  });

  it('an alias another Sage party claimed still counts when its chain passes a third Sage party\'s row (#1699 review)', async () => {
    // A ('Oak Co', Sage 311) -> M (Sage 399) -> S; B ('Oak Co', unstamped) -> S. Sage 312 must not take B.
    const s = await insPlain('Oak Co Survivor');
    const m = await insPlain('Oak Co Middle', 'sage', '399');
    const a = await insPlain('Oak Co', 'sage', '311');
    const b = await insPlain('Oak Co');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = ANY($1)', [[m, b], s]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [a, m]);
    expect((await syncSuppliers([party(312, 'Oak Co')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await byRef('312'))[0]).toMatchObject({ deleted: false, merged_into_id: null });
    expect((await pool.query('SELECT external_ref FROM suppliers WHERE id = $1', [b])).rows[0].external_ref).toBeNull();
  });

  it('a merged-away alias marked sage with no external_ref is unstamped, not another party\'s (#1699 review)', async () => {
    const survivor = await insPlain('Elm Co Survivor');
    const gone = await insPlain('Elm Co');
    await pool.query("UPDATE suppliers SET external_system = 'sage', deleted_at = now(), merged_into_id = $2 WHERE id = $1", [gone, survivor]);
    expect((await syncSuppliers([party(321, 'Elm Co')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await byRef('321')).toEqual([{ id: gone, deleted: true, merged_into_id: survivor }]);
  });

  it('a survivor carrying an external_ref with no external_system does not block the chain (#1699 review)', async () => {
    const survivor = await insPlain('Hazel Co Survivor', null, 'LEGACY-1');
    const gone = await insPlain('Hazel Co');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
    expect((await syncSuppliers([party(331, 'Hazel Co')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await byRef('331')).toEqual([{ id: gone, deleted: true, merged_into_id: survivor }]);
  });

  it('a Sage party cannot claim a live survivor of the same name that another Sage party was merged into', async () => {
    // Sage 1101 'Hex Co' was imported, then merged into a hand-keyed, unstamped survivor of the same name.
    const survivor = await insPlain('Hex Co');
    const merged101 = await insPlain('Hex Co', 'sage', '1101');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [merged101, survivor]);
    // Sage 1102, another supplier of that name, must not take the survivor (both parties' bills would land on one row).
    const warn = vi.spyOn(log, 'warn');
    const summary = await syncSuppliers([party(1102, 'Hex Co')]);
    expect(summary.suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    // Logged with both supplier ids and both Sage ids, and reported in the sync summary.
    const created = String((await byRef('1102'))[0].id);
    expect(warn).toHaveBeenCalledWith('Sage supplier created alongside a same-name supplier', expect.objectContaining({
      companyId, newSupplierId: created, existingSupplierId: survivor, newSageId: '1102', existingSageIds: ['1101'],
    }), 'sage-migration');
    expect(summary.warnings).toEqual([expect.stringContaining('created alongside a same-name supplier')]);
    warn.mockRestore();
    const own = await byRef('1102');
    expect(own).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    expect(own[0].id).not.toBe(survivor);
    expect((await pool.query('SELECT external_ref FROM suppliers WHERE id = $1', [survivor])).rows[0].external_ref).toBeNull();
    // 1101 still follows its merge to the survivor by its own id, and re-syncing both creates nothing.
    expect((await syncSuppliers([party(1101, 'Hex Co'), party(1102, 'Hex Co')])).suppliers).toEqual({ created: 0, skipped: 2, failed: [] });
    expect((await byRef('1101'))[0].merged_into_id).toBe(survivor);
  });
});
