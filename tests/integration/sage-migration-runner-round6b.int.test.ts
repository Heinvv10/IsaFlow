/**
 * Round-6 breaker findings on a real database (the breaker's repros b6-a/b/c/d/h/i, ported):
 *   - A: an unchanged re-run of a PO whose line amount is not quantity x unit price (a discount, a 4-dp price) lists no difference;
 *   - B: a lock lost in the MIDDLE of a phase stops the run before its next batch (no batch is committed while another run may hold the lock);
 *   - C: every batch that is in the books is named in the stop message (an unconfirmed COMMIT among them);
 *   - D: two live suppliers carrying one Sage reference refuse the POs naming it (supplier_ambiguous), none is booked to a guess;
 *   - E: with --allow-differences the gate compares --expect-po-total with the PROJECTED booked total, so a live run is not started to fail;
 *   - H: an item code with "]" in it: a line linked on run 1 and unlinked on run 2 is no description difference.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { formatCents } from '@/lib/money/formatMoney';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, booked, cleanupSageWorld, exportFile, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import { migrationLockKey } from '@/modules/accounting/services/sage-migration/sageRunLock';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const pos = (f: Row) => (Array.isArray(f.PurchaseOrders) ? f.PurchaseOrders : (f.PurchaseOrders as { $resources: Row[] }).$resources) as Row[];
const items = (f: Row) => (f.Items as { $resources: Row[] }).$resources;
const run = (f: Row = exportFile(), over: Record<string, unknown> = {}, p: Pool = pool) =>
  runSageMigration(p, parsedExport(f), { companyId: s.companyId, userId: s.userId, live: true, liveWithoutCounts: true, allowRefusals: true, allowDifferences: true, expect: {}, ...over });
const killLock = async () => {
  const [k1, k2] = migrationLockKey(s.companyId);
  await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted`,
    [String(BigInt.asUintN(32, BigInt(k1))), String(BigInt.asUintN(32, BigInt(k2)))]);
};

describe('B6-A: an unchanged re-run when the line amount is not quantity x unit price', () => {
  const variant = (kind: 'discount' | 'decimals'): Row => {
    const f = exportFile();
    const po = pos(f)[0]!;
    const lines = po.Lines as Row[];
    // discount: list price 400 less 12.5% -> Exclusive 350; decimals: 3 x 116.6666 = 349.9998 -> Exclusive 350.00
    const l2 = kind === 'discount' ? { ...lines[1], UnitPriceExclusive: 400 } : { ...lines[1], Quantity: 3, UnitPriceExclusive: 116.6666 };
    pos(f)[0] = { ...po, Lines: [lines[0], l2, lines[2]] };
    return f;
  };
  for (const kind of ['discount', 'decimals'] as const) {
    it(`${kind}: the second run of the SAME file lists no difference, goes live and exits 0`, async () => {
      expect((await run(variant(kind))).status).toBe('completed');
      const second = await run(variant(kind), { allowDifferences: false, allowRefusals: false });
      expect(second.differences.purchaseOrders).toEqual([]);
      expect(second.status).toBe('completed');
      expect(exitCodeFor(second, false, false)).toBe(0);
    });
  }
});

describe('B6-B: the lock lost in the middle of the PO phase', () => {
  it('run A commits no PO batch after the loss: it stops "lock lost" with the batches it did commit, while run B takes the lock and finishes', async () => {
    let b: Promise<unknown> | null = null;
    const hooked = afterCommitOf(pool, 'bulk_create_purchase_orders', {
      after: async () => {
        await killLock();
        await new Promise((r) => setTimeout(r, 100));
        b = run(exportFile(), { poBatchSize: 2 }).then((r) => r, (e: unknown) => e); // a second terminal: not awaited, it runs alongside A
      },
    });
    const a = await run(exportFile(), { poBatchSize: 2 }, hooked).then(() => null, (e: unknown) => e);
    expect(a).toBeInstanceOf(MigrationStopped);
    expect((a as MigrationStopped).message).toMatch(/lock lost/);
    expect((a as MigrationStopped).committed.filter((x) => x.entity === 'purchase_order').map((x) => x.n)).toEqual([1]);
    const rb = await b as { status: string; reconciliation: { purchaseOrders: { addedByRun: number } } };
    expect(rb.status).toBe('completed');
    expect(rb.reconciliation.purchaseOrders.addedByRun).toBe(8); // B added what A had not: the two of A's batch 1 are A's
    expect((await booked(pool, s.companyId)).pos).toBe(10);
  });
});

describe('B6-C: a committed batch whose reply was lost', () => {
  it('every PO batch that is in the books is named in the stop message, the lost-reply one as "commit unconfirmed"', async () => {
    let fired = false;
    const wrapped = {
      options: pool.options,
      connect: async () => {
        const c = await pool.connect();
        let po = false;
        return new Proxy(c, {
          get(t, p) {
            if (p === 'query') {
              return async (...a: unknown[]) => {
                const [text, params] = a as [unknown, unknown];
                if (text === 'BEGIN') po = false;
                if (typeof text === 'string' && text.includes('INSERT INTO mcp_tool_calls') && Array.isArray(params) && params.includes('bulk_create_purchase_orders')) po = true;
                const out = await (t.query as (...x: unknown[]) => Promise<unknown>)(...a);
                if (text === 'COMMIT' && po && !fired) {
                  fired = true; // the COMMIT landed; the network drops: the lock's backend goes and this reply never arrives
                  await killLock();
                  throw new Error('injected: connection lost before the COMMIT reply');
                }
                return out;
              };
            }
            const v = Reflect.get(t, p, t) as unknown;
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    } as unknown as Pool;
    const err = await run(exportFile(), { poBatchSize: 2 }, wrapped).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationStopped);
    const inBooks = (await pool.query('SELECT count(*)::INT AS n FROM purchase_orders WHERE company_id = $1', [s.companyId])).rows[0].n as number;
    expect(inBooks).toBe(2); // batch 1 landed; the lock was gone, so no other batch ran
    const listed = (err as MigrationStopped).committed.filter((b) => b.entity === 'purchase_order');
    expect(listed.map((b) => [b.n, b.commitUnconfirmed === true])).toEqual([[1, true]]);
    expect(stopMessage(err)).toMatch(/commit unconfirmed: purchase_order batch 1 \(/);
  });
});

describe('B6-D: two live suppliers carrying one Sage reference', () => {
  it('its POs are refused (supplier_ambiguous) and none is booked to either', async () => {
    const twin = String((await pool.query(`INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, 'Alpha Optics Cape Town branch', 'Sage', '301') RETURNING id`, [s.companyId])).rows[0].id);
    const r = await run();
    const to = (await pool.query('SELECT count(*)::INT AS n FROM purchase_orders WHERE company_id = $1 AND supplier_id = ANY($2::UUID[])', [s.companyId, [s.suppliers.alpha, twin]])).rows[0].n;
    expect(to).toBe(0);
    const refused = r.refused.filter((x) => x.entity === 'purchase_order' && x.code === 'supplier_ambiguous');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]!.reasons.join(' ')).toMatch(/301/);
  });
});

describe('B6-I: --expect-po-total with an allowed difference', () => {
  it('the gate compares the projected booked total: a run it lets through exits 0, one it would not is blocked before anything is committed', async () => {
    const first = exportFile();
    const keep = pos(first).slice(0, 2);
    if (Array.isArray(first.PurchaseOrders)) first.PurchaseOrders = keep; else { (first.PurchaseOrders as Row).$resources = keep; (first.PurchaseOrders as Row).$totalResults = 2; }
    expect((await run(first, { allowDifferences: false })).status).toBe('completed');
    const f = exportFile(); // Sage has since added a line to PO198 (+115.00)
    const p = pos(f)[1]!;
    pos(f)[1] = { ...p, Exclusive: (p.Exclusive as number) + 100, Tax: (p.Tax as number) + 15, Total: (p.Total as number) + 115,
      Lines: [...(p.Lines as Row[]), { Description: 'Extra', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, TaxPercentage: 15, Exclusive: 100, Tax: 15 }] };
    const sageTotal = pos(f).reduce((n, x) => n + Math.round((x.Total as number) * 100), 0);
    // What Sage says (R115 more than the books will hold for PO198) is not what will be booked: blocked, nothing committed.
    const before = await booked(pool, s.companyId);
    const blocked = await run(f, { allowRefusals: false, expect: { items: 20, purchaseOrders: 10, purchaseOrderTotalCents: sageTotal } });
    expect(blocked.status).toBe('live_blocked');
    expect(blocked.liveBlockedBy.join(' ')).toMatch(/--expect-po-total/);
    expect(blocked.liveBlockedBy.join(' ')).toContain(formatCents(sageTotal)); // money, not bare cents next to a flag given in rands
    expect(await booked(pool, s.companyId)).toEqual(before);
    // The projected figure (the books' PO198 total plus the sent totals of the new ones) goes through and exits 0.
    const projected = sageTotal - 11500;
    const ok = await run(f, { allowRefusals: false, expect: { items: 20, purchaseOrders: 10, purchaseOrderTotalCents: projected } });
    expect(ok.status).toBe('completed');
    expect(exitCodeFor(ok, false, true)).toBe(0);
  });
});

describe('B6-H: an item code with "]" in it', () => {
  const file = (code: string, active: boolean): Row => {
    const f = exportFile();
    items(f)[0] = { ...items(f)[0], Code: code, Active: active };
    return f;
  };
  for (const code of ['FIB-0001', 'FIB]0001']) {
    it(`code ${code}: the item deactivated in Sage after the import is no description difference`, async () => {
      expect((await run(file(code, true))).status).toBe('completed');
      const r = await run(file(code, false), { live: false });
      const fields = r.differences.purchaseOrders.flatMap((p) => p.differences.map((d) => d.field));
      expect(fields.filter((x) => /description/.test(x))).toEqual([]);
    });
  }
});
