/**
 * PR #1703, ledger breaker round 15 F1 (ported from zz-b15-attack M / H at b875e6cc2d), real PostgreSQL 16. The link's bill locks
 * (own FOR UPDATE, ties FOR SHARE NOWAIT) are retried in their own savepoint, up to TIED_BILL_ATTEMPTS with a 10-50 ms jitter, the
 * own-bill locks released between attempts, before the call is refused:
 *   M  two links whose own bills tie each other's PO (mutual refusal, 52% of rounds at b875) succeed without a caller retry;
 *   H  a hot tied bill (short UPDATEs) mostly does not refuse the link.
 * Also (review r15 L3) the plain flow: a link closes a PO by billing, then cancelling its sole billed bill reopens it.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, type Json } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { cancelSupplierInvoiceTool as cancelBill } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 14 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r15'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 120_000);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function approvedBill(amount: number) {
  const b = await seedBill(pool, f, { status: 'draft', lines: [amount] });
  await approveBill(pool, f, b.id);
  await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [b.id]);
  return b;
}
const linkRow = (po: string, bill: string, amount: number) => pool.query(
  "INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, created_by) VALUES ($1, $2, $3, $4, 'app', $5)",
  [f.co, po, bill, amount, f.owner]);
/** One link call, its outcome: ok, retry (the typed busy refusal), or anything else (named). */
const outcome = (args: Json) => callTool(pool, f, link, args).then(
  (r) => (r.isError ? `refused ${r.text.slice(0, 60)}` : 'ok'),
  (e: unknown) => ((e as { code?: string }).code === 'ROW_LOCK_TIMEOUT' ? 'retry' : `threw ${(e as { code?: string }).code ?? ''} ${String(e).slice(0, 80)}`));

describe('M: two links whose own bills tie each other\'s PO', () => {
  it('succeed without a caller retry in >= 35 of 40 rounds; never a 40P01', async () => {
    const tally: Record<string, number> = {};
    let bothOk = 0;
    for (let round = 0; round < 40; round++) {
      const p1 = await seedPo(pool, f, { lines: [1000] }); const p2 = await seedPo(pool, f, { lines: [1000] }); const p3 = await seedPo(pool, f, { lines: [1000] });
      const x = await approvedBill(100); await linkRow(p2.po, x.id, 25); await linkRow(p3.po, x.id, 25);
      const y = await approvedBill(100); await linkRow(p1.po, y.id, 25); await linkRow(p3.po, y.id, 25);
      const [a, b] = await Promise.all([
        outcome({ links: [{ po_id: p1.po, bill_id: x.id, amount: 50 }], close_when_fully_billed: true }),
        outcome({ links: [{ po_id: p2.po, bill_id: y.id, amount: 50 }], close_when_fully_billed: true }),
      ]);
      for (const k of [a, b]) tally[k] = (tally[k] ?? 0) + 1;
      if (a === 'ok' && b === 'ok') bothOk += 1;
    }
    console.info('R15-M', JSON.stringify({ bothOk, tally }));
    expect(Object.keys(tally).filter((k) => k !== 'ok' && k !== 'retry'), 'no deadlock, no other failure').toEqual([]);
    expect(bothOk).toBeGreaterThanOrEqual(35);
  }, 600_000);
});

describe('H: a hot tied bill (short UPDATEs)', () => {
  it('mostly does not refuse the link (>= 20 of 30 at the first call); a refusal is the typed retryable one', async () => {
    const p: SeededPo = await seedPo(pool, f, { lines: [100000] });
    const hot = await approvedBill(100); await linkRow(p.po, hot.id, 100);
    let stop = false;
    const toucher = (async () => {
      const c = await pool.connect();
      try {
        while (!stop) {
          await c.query('BEGIN'); await c.query('UPDATE supplier_invoices SET updated_at = NOW() WHERE id = $1', [hot.id]);
          await sleep(15); await c.query('COMMIT'); await sleep(10);
        }
      } finally { c.release(); }
    })();
    const tally: Record<string, number> = {};
    try {
      for (let i = 0; i < 30; i++) {
        const x = await approvedBill(1);
        const k = await outcome({ links: [{ po_id: p.po, bill_id: x.id, amount: 1 }], dry_run: i % 3 === 0 });
        tally[k] = (tally[k] ?? 0) + 1;
      }
    } finally { stop = true; await toucher; }
    console.info('R15-H', JSON.stringify(tally));
    expect(Object.keys(tally).filter((k) => k !== 'ok' && k !== 'retry')).toEqual([]);
    expect(tally.ok ?? 0).toBeGreaterThanOrEqual(20);
  }, 600_000);
});

describe('review r15 L3: the plain flow', () => {
  it('a link closes the PO by billing; cancelling its sole billed bill reopens it and it commits again', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const h = await approvedBill(1000);
    const l = await callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: h.id }], close_when_fully_billed: true });
    expect(l.isError, l.text).toBe(false);
    expect((await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [p.po])).rows[0]).toEqual({ status: 'closed', closed_by_billing: true });
    expect((await poCommittedCents(f.co, [p.po])).get(p.po.toLowerCase()) ?? 0).toBe(0);
    const c = await callTool(pool, f, cancelBill, { invoice_id: h.id });
    expect(c.isError, c.text).toBe(false);
    expect(c.body.reopened_purchase_orders).toEqual([{ purchase_order_id: p.po, po_number: p.number, reopened_to: 'approved' }]);
    expect((await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [p.po])).rows[0]).toEqual({ status: 'approved', closed_by_billing: false });
    expect((await poCommittedCents(f.co, [p.po])).get(p.po.toLowerCase()) ?? 0).toBe(100000);
  }, 60_000);
});
