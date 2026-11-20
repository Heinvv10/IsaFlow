/**
 * #1655 review M1: a supplier merged away (A into B) must not come back on a Sage
 * re-sync. Before migration 1020 nothing recorded the survivor, and the Sage match
 * (live rows only) re-created A as a new live supplier, so A's new Sage bills
 * landed there and AP split from B. Now mergeSuppliers sets merged_into_id and
 * sagePartyMatch follows a deleted, merged supplier to its live survivor (a bounded,
 * cycle-safe chain). Through the real merge, commit and AP import on a throwaway
 * cluster, each in a committed request transaction. The same-name alias, ambiguity and
 * concurrency cases are in i1655-sage-merged-supplier-aliases.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitAPInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { restoreRow } from '@/modules/accounting/services/core/softDeleteRowOps';
import { MAX_MERGE_HOPS } from '@/modules/admin/services/sagePartyMatch';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { party, sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('merged');
const { pool, companyId, userId, tag, inRequestTx, syncSuppliers, byRef, liveNamed, insPlain, bill, billSupplier } = w;

let a = '';
let b = '';

beforeAll(async () => {
  await w.seed();
  // Sage holds A and B as two suppliers; IsaFlow imports both, then a user merges A into B.
  await syncSuppliers([party(801, 'Hill Hardware'), party(802, 'Hill Hardware Pty Ltd')]);
  a = String((await byRef('801'))[0].id);
  b = String((await byRef('802'))[0].id);
  await inRequestTx(() => mergeEntities(companyId, 'supplier', b, a, userId));
}, 60000);

afterAll(() => w.drop(), 60000);

describe('a merged-away supplier resolves to its survivor on a Sage re-sync (#1655 M1)', () => {
  it('the merge records its survivor', async () => {
    expect(await byRef('801')).toEqual([{ id: a, deleted: true, merged_into_id: b }]);
  });

  it('re-syncing both Sage suppliers inserts nothing: A matches B, and B keeps its own Sage id', async () => {
    expect((await syncSuppliers([party(801, 'Hill Hardware'), party(802, 'Hill Hardware Pty Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await liveNamed('Hill Hardware')).toEqual([]);
    expect(await liveNamed('Hill Hardware Pty Ltd')).toEqual([{ id: b, external_ref: '802' }]);
  });

  it('a pull without Sage ids still reaches the survivor by the merged-away name', async () => {
    expect((await syncSuppliers([party(undefined, 'hill hardware ')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await liveNamed('Hill Hardware')).toEqual([]);
  });

  it('a survivor reached through a merge is not stamped with the merged-away Sage id', async () => {
    // B2 was keyed in by hand (no Sage id); Sage A2 was imported and then merged into it.
    const b2 = String((await pool.query("INSERT INTO suppliers (company_id, name) VALUES ($1, 'Ivy Paints Ltd') RETURNING id",
      [companyId])).rows[0].id);
    await syncSuppliers([party(811, 'Ivy Paints')]);
    const a2 = String((await byRef('811'))[0].id);
    await inRequestTx(() => mergeEntities(companyId, 'supplier', b2, a2, userId));
    // A2 first: it reaches B2 through the merge and must leave B2 unstamped, so Sage's own B2 (812) still finds it by name.
    expect((await syncSuppliers([party(811, 'Ivy Paints'), party(812, 'Ivy Paints Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await liveNamed('Ivy Paints Ltd')).toEqual([{ id: b2, external_ref: '812' }]);
    // 811 now meets a survivor carrying 812, and still follows the merge by its own id.
    expect((await syncSuppliers([party(811, 'Ivy Paints'), party(812, 'Ivy Paints Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
  });

  it("a new Sage bill for A lands on B", async () => {
    const number = `AP-M1-${tag}`;
    const out = await inRequestTx(() => commitAPInvoice(companyId, userId, {
      invoiceNumber: number, supplierName: 'Hill Hardware', supplierSageId: 801, invoiceDate: '2026-04-02',
      subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
    }));
    expect(out.created).toBe(true);
    const { rows } = await pool.query('SELECT supplier_id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, number]);
    expect(rows.map((r) => String(r.supplier_id))).toEqual([b]);
  });

  it('a chain (C into D, D into E) resolves to the end; a cycle of deleted rows ends, and the party is created live', async () => {
    const ins = async (name: string, ref: string) => String((await pool.query(
      "INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, 'sage', $3) RETURNING id",
      [companyId, name, ref])).rows[0].id);
    const [cId, dId, eId] = [await ins('Chain C', '901'), await ins('Chain D', '902'), await ins('Chain E', '903')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [cId, dId]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [dId, eId]);
    expect((await syncSuppliers([party(901, 'Chain C')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await liveNamed('Chain C'))).toEqual([]);

    const [xId, yId] = [await ins('Loop X', '911'), await ins('Loop Y', '912')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [xId, yId]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [yId, xId]);
    expect((await syncSuppliers([party(911, 'Loop X')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Loop X')).map((r) => r.external_ref)).toEqual(['911']);
  });

  it('a chain longer than MAX_MERGE_HOPS does not reach the far survivor: the party is created live', async () => {
    const ins = async (name: string, ref: string | null) => String((await pool.query(
      "INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, $3, $4) RETURNING id",
      [companyId, name, ref ? 'sage' : null, ref])).rows[0].id);
    // MAX_MERGE_HOPS + 1 merged-away rows ending in one live survivor: the survivor is MAX_MERGE_HOPS + 1 hops from the first.
    const live = await ins('Long Chain Survivor', null);
    let next = live;
    const ids: string[] = [];
    for (let i = MAX_MERGE_HOPS; i >= 0; i--) {
      const id = await ins(`Long Chain ${i}`, i === 0 ? '921' : null);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [id, next]);
      ids.push(id);
      next = id;
    }
    expect((await syncSuppliers([party(921, 'Long Chain 0')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Long Chain 0')).map((r) => r.external_ref)).toEqual(['921']);
    // The same chain one hop shorter does resolve (the cap is MAX_MERGE_HOPS hops, inclusive).
    const shortLive = await ins('Short Chain Survivor', null);
    let hop = shortLive;
    let first = '';
    for (let i = MAX_MERGE_HOPS; i > 0; i--) {
      first = await ins(`Short Chain ${i}`, i === 1 ? '922' : null);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [first, hop]);
      hop = first;
    }
    expect((await syncSuppliers([party(922, 'Short Chain 1')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await liveNamed('Short Chain 1')).toEqual([]);
  });

  it('a name hit on an unstamped merged-away row stamps it, so a later different Sage party of that name gets its own row', async () => {
    // Imported by hand (no Sage id), merged into a survivor, as before Sage ever knew it.
    const ins = async (name: string) => String((await pool.query(
      'INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name])).rows[0].id);
    const survivor = await ins('Oak Timber Pty Ltd');
    const gone = await ins('Oak Timber');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    expect((await syncSuppliers([party(931, 'Oak Timber')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    // The merged-away row is stamped; the survivor is not.
    expect(await byRef('931')).toEqual([{ id: gone, deleted: true, merged_into_id: survivor }]);
    expect(await liveNamed('Oak Timber Pty Ltd')).toEqual([{ id: survivor, external_ref: null }]);
    // A genuinely different Sage supplier of the same name gets its own live row.
    expect((await syncSuppliers([party(932, 'Oak Timber')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Oak Timber')).map((r) => r.external_ref)).toEqual(['932']);
    // Re-syncing the first still resolves to the survivor and creates nothing.
    expect((await syncSuppliers([party(931, 'Oak Timber')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await liveNamed('Oak Timber')).map((r) => r.external_ref)).toEqual(['932']);
    expect(await liveNamed('Oak Timber Pty Ltd')).toEqual([{ id: survivor, external_ref: null }]);
  });

  it('a pull with no Sage id reaches the survivor and stamps nothing', async () => {
    const ins = async (name: string) => String((await pool.query(
      'INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name])).rows[0].id);
    const survivor = await ins('Elm Supplies Pty Ltd');
    const gone = await ins('Elm Supplies');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    expect((await syncSuppliers([party(undefined, 'Elm Supplies')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    const { rows } = await pool.query('SELECT external_ref FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0].external_ref).toBeNull();
    // Nothing was stamped and no live alias of the name was created.
    expect(await liveNamed('Elm Supplies')).toEqual([]);
    expect(await liveNamed('Elm Supplies Pty Ltd')).toEqual([{ id: survivor, external_ref: null }]);
  });

  it('restoring a merged-away supplier clears its survivor link', async () => {
    const survivor = await insPlain('Reed Co Survivor');
    const gone = await insPlain('Reed Co');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    const { rows: before } = await pool.query('SELECT deleted_at, merged_into_id FROM suppliers WHERE id = $1', [gone]);
    expect(before[0].deleted_at).not.toBeNull();
    expect(before[0].merged_into_id).toBe(survivor);
    expect(await inRequestTx(() => restoreRow('supplier', gone, companyId))).toBe(true);
    const { rows } = await pool.query('SELECT deleted_at, merged_into_id FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0]).toEqual({ deleted_at: null, merged_into_id: null });
  });

  it.each([[true], [false]])('restoring a supplier merged by duplicates-merge (active: %s) leaves is_active as it was', async (active) => {
    const survivor = await insPlain(`Dup Restore Survivor ${active}`);
    const gone = await insPlain(`Dup Restore ${active}`);
    await pool.query('UPDATE suppliers SET is_active = $2 WHERE id = $1', [gone, active]);
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    expect(await inRequestTx(() => restoreRow('supplier', gone, companyId))).toBe(true);
    const { rows } = await pool.query('SELECT name, is_active, deleted_at, merged_into_id FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0]).toEqual({ name: `Dup Restore ${active}`, is_active: active, deleted_at: null, merged_into_id: null });
  });

  it.each([[true], [false]])('restoring a supplier merged by the route (active: %s) strips the suffix and leaves is_active as it was', async (active) => {
    const survivor = await insPlain(`Rush Co Survivor ${active}`);
    const gone = await insPlain(`Rush Co ${active}`);
    await pool.query('UPDATE suppliers SET is_active = $2 WHERE id = $1', [gone, active]);
    // As the supplier-merge route leaves it (the route's own SQL is exercised in supplier-merge-route-drc-flag).
    await pool.query("UPDATE suppliers SET name = name || ' [MERGED]', deleted_at = now(), merged_into_id = $2 WHERE id = $1", [gone, survivor]);
    expect(await inRequestTx(() => restoreRow('supplier', gone, companyId))).toBe(true);
    const { rows } = await pool.query('SELECT name, is_active, deleted_at, merged_into_id FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0]).toEqual({ name: `Rush Co ${active}`, is_active: active, deleted_at: null, merged_into_id: null });
  });
});
