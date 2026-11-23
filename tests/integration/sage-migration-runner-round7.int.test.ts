/**
 * Round-7 review findings on a real database:
 *   - M1: a run finishing normally with a batch whose COMMIT did not answer says so and exits 4;
 *   - M2: POs already booked are not refused on a re-run when their supplier was renamed, deleted or lost its reference: they are sent
 *     (the tool replays them) and the supplier problem is listed as a difference;
 *   - L1: the lock is asked before EVERY batch: a lock connection that stops answering stops the run before the next batch;
 *   - L5: a Sage PO reference carried by two IsaFlow POs refuses the PO that names it.
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

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const run = (over: Record<string, unknown> = {}, p: Pool = pool) =>
  runSageMigration(p, parsedExport(exportFile()), { companyId: s.companyId, userId: s.userId, live: true, allowRefusals: false, allowDifferences: false, ...over });

describe('M1: a COMMIT that did not answer, in a run that otherwise finishes', () => {
  it('the summary names the batch and the exit code is 4, not 1', async () => {
    const r = await run({ allowRefusals: true, allowDifferences: true }, failingCommitPool(pool, [5])); // 4 categories, then the item batch
    expect(r.status).toBe('failed');
    expect(summaryLines(r).join('\n')).toMatch(/COMMIT UNCONFIRMED: item batch 1 \(sage-mig-item-0001-[0-9a-f]+\): it may have been committed; check the books/);
    expect(exitCodeFor(r, true, true)).toBe(4);
  });
});

describe('M2: a re-run after the suppliers changed in IsaFlow', () => {
  it('suppliers found by name, then renamed: the booked POs are still sent, nothing refused, the problem is listed and blocks live without --allow-differences', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query(`UPDATE suppliers SET name = 'Bravo Renamed' WHERE id = $1`, [s.suppliers.bravo]);
    await pool.query(`UPDATE suppliers SET name = 'Charlie Renamed' WHERE id = $1`, [s.suppliers.charlie]);
    const blocked = await run({ expect: { items: 20, purchaseOrders: 10 } });
    expect(blocked.refused).toEqual([]);
    expect(blocked.status).toBe('live_blocked');
    const supplierDiffs = blocked.differences.purchaseOrders.flatMap((p) => p.differences.filter((d) => d.field === 'supplier').map((d) => ({ po: p.poNumber, text: String(d.requested) })));
    expect(supplierDiffs.length).toBeGreaterThan(0);
    for (const d of supplierDiffs) expect(d.text).toMatch(/not found in IsaFlow.*PO is booked to/s);
    // allowed: the run goes on, the books keep their suppliers, --expect-pos 10 holds, exit 0
    const before = (await pool.query('SELECT po_number, supplier_id::TEXT AS s FROM purchase_orders WHERE company_id = $1 ORDER BY po_number', [s.companyId])).rows;
    const ok = await run({ allowDifferences: true, expect: { items: 20, purchaseOrders: 10 } });
    expect(ok.status).toBe('completed');
    expect(exitCodeFor(ok, false, true)).toBe(0);
    expect((await pool.query('SELECT po_number, supplier_id::TEXT AS s FROM purchase_orders WHERE company_id = $1 ORDER BY po_number', [s.companyId])).rows).toEqual(before);
  });
  it('the supplier that carried the Sage reference loses it and is renamed: its POs are sent too, and listed', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query(`UPDATE suppliers SET name = 'Alpha Renamed', external_system = NULL, external_ref = NULL WHERE id = $1`, [s.suppliers.alpha]);
    const r = await run({ allowDifferences: true, live: false });
    expect(r.refused).toEqual([]);
    expect(r.differences.purchaseOrders.some((p) => p.differences.some((d) => d.field === 'supplier' && /Alpha Renamed/.test(String(d.requested))))).toBe(true);
  });
  it('a supplier DELETED in IsaFlow (a hard delete is impossible: the PO references it): the POs booked to it are refused with the remedy, the others go on', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query('UPDATE suppliers SET deleted_at = now(), name = $2 WHERE id = $1', [s.suppliers.charlie, 'charlie gone']);
    const r = await run({ allowRefusals: true, allowDifferences: true });
    const gone = r.refused.filter((x) => x.code === 'booked_supplier_deleted');
    expect(gone.length).toBeGreaterThan(0);
    expect(gone[0]!.reasons[0]).toMatch(/deleted in IsaFlow.*Restore that supplier/);
    expect(r.dryRun.clean).toBe(true); // the batch is not sent with a supplier the tool cannot find
    expect(r.status).toBe('completed');
    expect(exitCodeFor(r, false, true)).toBe(1); // refusals not allowed: not a clean run
  });
  it('a NEW PO for a supplier that does not resolve is still refused', async () => {
    await pool.query(`UPDATE suppliers SET name = 'Bravo Renamed' WHERE id = $1`, [s.suppliers.bravo]);
    const r = await run({ allowRefusals: true, live: false });
    expect(r.refused.filter((x) => x.code === 'supplier_unresolved').length).toBeGreaterThan(0);
  });
});

describe('L1: the lock is asked before every batch', () => {
  /** A pool whose lock connection (the one that ran pg_try_advisory_lock) stops answering SELECT 1 once `hang()` has been called. */
  function lockSpy(base: Pool): { pool: Pool; hang: () => void } {
    let hanging = false;
    const spy = {
      options: base.options,
      connect: async () => {
        const c = await base.connect();
        let isLock = false;
        return new Proxy(c, {
          get(t, p) {
            if (p === 'query') {
              return (...a: unknown[]) => {
                if (typeof a[0] === 'string' && a[0].includes('pg_try_advisory_lock')) isLock = true;
                if (isLock && hanging && a[0] === 'SELECT 1') return new Promise(() => undefined); // half-open: no answer, no error
                return (t.query as (...x: unknown[]) => Promise<unknown>)(...a);
              };
            }
            const v = Reflect.get(t, p, t) as unknown;
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    } as unknown as Pool;
    return { pool: spy, hang: () => { hanging = true; } };
  }
  it('after PO batch 1 the lock connection stops answering: batch 2 is not committed, the run stops "lock lost" within the probe timeout', async () => {
    const { pool: spied, hang } = lockSpy(pool);
    const hooked = afterCommitOf(spied, 'bulk_create_purchase_orders', { after: async () => { hang(); } });
    const err = await run({ allowRefusals: true, allowDifferences: true, poBatchSize: 2 }, hooked).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationStopped);
    expect((err as MigrationStopped).message).toMatch(/lock lost.*no answer within/);
    expect((err as MigrationStopped).committed.filter((b) => b.entity === 'purchase_order').map((b) => b.n)).toEqual([1]);
    expect((await booked(pool, s.companyId)).pos).toBe(2);
  }, 60_000);
});

describe('L5: a Sage PO reference carried by two IsaFlow POs', () => {
  it('refuses the PO that names it (po_ref_ambiguous), naming both numbers; the others are imported', async () => {
    const sup = s.suppliers.bravo;
    await pool.query(`INSERT INTO purchase_orders (company_id, po_number, supplier_id, external_system, external_ref) VALUES ($1, 'DUP-1', $2, 'sage', '900197'), ($1, 'DUP-2', $2, 'sage', '900197')`, [s.companyId, sup]);
    const r = await run({ allowRefusals: true, allowDifferences: true });
    const refused = r.refused.filter((x) => x.label === 'PO0000197');
    expect(refused.map((x) => x.code)).toEqual(['po_ref_ambiguous']);
    expect(refused[0]!.reasons[0]).toMatch(/DUP-1, DUP-2|DUP-2, DUP-1/);
    expect((await pool.query(`SELECT count(*)::INT AS n FROM purchase_orders WHERE company_id = $1 AND po_number = 'PO0000197'`, [s.companyId])).rows[0].n).toBe(0);
  });
});
