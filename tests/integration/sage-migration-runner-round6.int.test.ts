/**
 * Round-6 findings on a real database:
 *   - H1: an unchanged re-run lists no PO difference for lines the PO tool stores at net / quantity (a discount line, a 3-dp price, a repeating price);
 *   - M1: a PO already booked is still sent on a re-run after its supplier was deactivated or the budget policy became block;
 *   - L1: a lock lost before the live phase is a refused start (not "may have committed"), nothing written;
 *   - L2: a batch whose COMMIT failed is flagged commitUnconfirmed (and, since round 10, stops the run there), and one the tool refused is not.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, failingCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { migrationLockKey } from '@/modules/accounting/services/sage-migration/sageRunLock';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => {
  await pool.query('DELETE FROM budget_control_settings WHERE company_id = $1', [s.companyId]);
  await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w);
}, 120_000);

type Row = Record<string, unknown>;
const opts = (over: Record<string, unknown> = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, liveWithoutCounts: true, ...over });
const run = (file: Row = exportFile(), over: Record<string, unknown> = {}, p: Pool = pool) => runSageMigration(p, parsedExport(file), opts(over));

/** PO0000197 with a 10% discount line, a per-metre price of 3 dp and a price that repeats (10.00 / 7); header totals follow the lines. */
function oddPrices(): Row {
  const f = exportFile();
  const po = (f.PurchaseOrders as Row[])[0]!;
  const l = po.Lines as Row[];
  l[0] = { ...l[0], Quantity: 2, UnitPriceExclusive: 100, Exclusive: 180, Tax: 27, Total: 207 };
  l[1] = { ...l[1], Quantity: 1, UnitPriceExclusive: 1.234, Exclusive: 1.23, Tax: 0.18, Total: 1.41 };
  l[2] = { ...l[2], Quantity: 7, UnitPriceExclusive: 1.4285, Exclusive: 10, Tax: 1.5, Total: 11.5 };
  Object.assign(po, { Exclusive: 191.23, Tax: 28.68, Total: 219.91 });
  return f;
}

describe('H1: stored unit prices', () => {
  it('an unchanged re-run of a PO with a discount line, a 3-dp price and a repeating price has no difference, exits 0 and is not blocked', async () => {
    expect((await run(oddPrices())).status).toBe('completed');
    const stored = (await pool.query(`SELECT i.unit_price::TEXT AS p FROM po_items i JOIN purchase_orders o ON o.id = i.purchase_order_id WHERE o.company_id = $1 AND o.po_number = 'PO0000197' ORDER BY i.sort_order`, [s.companyId])).rows.map((r) => r.p);
    expect(stored).toEqual(['90.000000', '1.230000', '1.428571']); // the tool stores net / quantity, not the Sage price
    const r = await run(oddPrices(), { allowDifferences: false, allowRefusals: false });
    expect(r.differences).toEqual({ purchaseOrders: [], items: [], categories: [] });
    expect(r.status).toBe('completed');
    expect(exitCodeFor(r, false, false)).toBe(0);
  });
  it('and a real change on such a PO (the discount line now 3 units at 100) is still listed', async () => {
    await run(oddPrices());
    const f = oddPrices();
    const l = ((f.PurchaseOrders as Row[])[0]!.Lines as Row[]);
    l[0] = { ...l[0], Quantity: 3, UnitPriceExclusive: 60, Exclusive: 180, Tax: 27 };
    const r = await run(f, { allowDifferences: false, allowRefusals: false });
    expect(r.differences.purchaseOrders.find((x) => x.poNumber === 'PO0000197')!.differences.map((d) => d.field)).toEqual(expect.arrayContaining(['line 1 quantity', 'line 1 unit_price']));
    expect(r.status).toBe('live_blocked');
  });
});

describe('M1: a booked PO on a re-run', () => {
  const rerun = () => run(exportFile(), { allowDifferences: false, allowRefusals: false, expect: { items: 20, purchaseOrders: 10 } });
  it('its supplier deactivated since the first import: all ten POs are still sent, nothing refused, --expect-pos 10 holds, exit 0', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query('UPDATE suppliers SET is_active = false WHERE company_id = $1', [s.companyId]);
    const r = await rerun();
    expect(r.refused).toEqual([]);
    expect(r.status).toBe('completed');
    expect(exitCodeFor(r, false, false)).toBe(0);
    expect((await booked(pool, s.companyId)).pos).toBe(10);
  });
  it('the budget policy block since the first import: the open POs are still sent, nothing refused, exit 0', async () => {
    expect((await run()).status).toBe('completed');
    await pool.query(`INSERT INTO budget_control_settings (company_id, check_policy) VALUES ($1, 'block') ON CONFLICT (company_id) DO UPDATE SET check_policy = 'block'`, [s.companyId]);
    const r = await rerun();
    expect(r.refused).toEqual([]);
    expect(r.status).toBe('completed');
    expect(exitCodeFor(r, false, false)).toBe(0);
  });
  it('a new PO is still refused for the inactive supplier (the exemption is for POs already booked)', async () => {
    await pool.query('UPDATE suppliers SET is_active = false WHERE id = $1', [s.suppliers.alpha]);
    const r = await run(exportFile(), { allowRefusals: true, live: false });
    expect(r.refused.filter((x) => x.code === 'supplier_inactive').length).toBeGreaterThan(0);
  });
});

describe('L1: a lock lost before the live phase', () => {
  /** A pool that runs `after` once the Nth ROLLBACK has gone through: the 1st ends the snapshot read, the 2nd the dry run. */
  function afterNthRollback(base: Pool, n: number, after: () => Promise<void>): Pool {
    let rollbacks = 0;
    return {
      options: base.options,
      connect: async () => {
        const client = await base.connect();
        return new Proxy(client, {
          get(target, prop) {
            if (prop === 'query') {
              return async (...args: unknown[]) => {
                const out = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
                if (args[0] === 'ROLLBACK' && ++rollbacks === n) await after();
                return out;
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    } as unknown as Pool;
  }
  it('killed during the dry run: a refused start (not MigrationStopped, so no "may have committed"), nothing written', async () => {
    const [k1, k2] = migrationLockKey(s.companyId);
    const hooked = afterNthRollback(pool, 2, async () => {
      await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted`,
        [String(BigInt.asUintN(32, BigInt(k1))), String(BigInt.asUintN(32, BigInt(k2)))]);
      await new Promise((r) => setTimeout(r, 150));
    });
    const err = await run(exportFile(), {}, hooked).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MigrationStopped);
    expect((err as Error).message).toMatch(/lock lost/);
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0 });
  });
});

describe('L2: a batch whose COMMIT failed', () => {
  it('is flagged commitUnconfirmed where the stop lists it (the run stops there, exit 4); the batches before it are not', async () => {
    const err = await run(exportFile(), {}, failingCommitPool(pool, [5])).then(() => null, (e: unknown) => e); // 4 categories, then the item batch
    expect(err).toBeInstanceOf(MigrationStopped);
    expect(exitCodeForError(err)).toBe(4);
    const listed = (err as MigrationStopped).committed;
    const item = listed.find((b) => b.entity === 'item')!;
    expect(item.status).toBe('failed');
    expect(item.commitUnconfirmed).toBe(true);
    expect(item.error).toMatch(/COMMIT 5 failed/);
    expect(listed.filter((b) => b.entity === 'category').every((b) => !b.commitUnconfirmed)).toBe(true);
  });
  it('a batch the tool refuses is a failure with nothing committed, and is not flagged', async () => {
    const f = exportFile();
    (f.PurchaseOrders as Row[])[0] = { ...(f.PurchaseOrders as Row[])[0], Total: 1 }; // expected_totals the lines do not add up to: the plan refuses it first
    const r = await run(f, { allowRefusals: true });
    expect(r.live!.purchaseOrders.batches.every((b) => !b.commitUnconfirmed)).toBe(true);
  });
  it('the stop lists it as "commit unconfirmed", next to the batches that did commit', async () => {
    // The 1st category batch commits; the 2nd one's COMMIT fails: the run stops there (categories 3 and 4 are never sent).
    const err = await run(exportFile(), {}, failingCommitPool(pool, [2])).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationStopped);
    const message = stopMessage(err);
    expect(message).toMatch(/committed: category batch 1 \(/);
    expect(message).toMatch(/commit unconfirmed: category batch 2 \(/);
    expect((err as MigrationStopped).committed.map((b) => b.n)).toEqual([1, 2]);
    expect(await booked(pool, s.companyId)).toMatchObject({ categories: 1, items: 0 });
  });
});
