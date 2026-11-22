/**
 * PR #1703, ledger breaker round 12 (ported from its zz-b12 repros at c2f1687472), real PostgreSQL 16:
 *   F2  a link call locks every bill that ties a requested PO (link rows FOR UPDATE; header / lines ties FOR SHARE NOWAIT, breaker
 *       r13), so a cancel or delete of a header / lines tie that is done but uncommitted refuses the link at once, retryably, and
 *       the retry after it commits sees the bill gone;
 *   F1 / F3  the bulk cancel locks each bill in its own item (one held bill fails one item) and the late PO re-check is NOWAIT, so
 *       the D1 / D2 interleavings never deadlock;
 *   F4  the planner's header transfer is signed: a lines link that grows a header residual counts the growth (reply = reader);
 *   R12-P  randomised: reply billed = reader, no close unless fully billed, dry run = real.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { poBillingBasisCents } from '@/modules/accounting/services/budgets/remainingCommitted';
import { callTool, type Json } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, seedRawBill, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { getPurchaseOrderTool as getPo } from '@/lib/mcp/tools/getPurchaseOrder';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { lockPosClosedByBilling, poCommittedCents } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';
import { billedCentsByPo } from '@/modules/accounting/services/ap/purchaseOrderBilled';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import { withSavepoint } from '@/lib/neon';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 14 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r12'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

const flag = async (po: SeededPo) => (await pool.query('SELECT status, closed_from_status, closed_by_billing FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
const billed = async (po: SeededPo) => (await billedCentsByPo(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
const budgetCommitted = async (po: SeededPo) => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {});
  return po.items.reduce((s, id) => { const r = rows.find((x) => x.poItemId === id); return s + (r ? openPoLineCents(r.lineTotal, r.billed) : 0); }, 0);
};
async function inv(po: SeededPo) {
  const fl = await flag(po);
  const b = await billed(po);
  const sub = Math.round(Number((await pool.query('SELECT subtotal FROM purchase_orders WHERE id = $1', [po.po])).rows[0].subtotal) * 100);
  const committing = ['approved', 'partially_received', 'received'].includes(fl.status) || (fl.status === 'closed' && fl.closed_by_billing);
  const expected = committing ? Math.max(0, sub - b) : 0;
  const budget = await budgetCommitted(po);
  const svc = (await poCommittedCents(f.co, [po.po])).get(po.po.toLowerCase()) ?? 0;
  const d = JSON.parse((await callTool(pool, f, getPo, { po_id: po.po })).text);
  const statusOk = !(fl.status === 'closed' && fl.closed_by_billing && !(b > 0 && b >= sub - 1));
  return { ...fl, billed: b, subtotal: sub, expected, budget, svc, closed_under_billed: d.closed_under_billed, committedOk: budget === expected && svc === expected, statusOk };
}
async function waitLocked(n = 1, ms = 6000) {
  for (let i = 0; i < ms / 50; i++) {
    const r = await pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (r.rows.length >= n) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}
async function approvedBill(amount: number, header?: string, poItem?: string) {
  const b = await seedBill(pool, f, { status: 'draft', lines: [amount] });
  await approveBill(pool, f, b.id);
  await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [b.id]);
  if (header) await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [b.id, header]);
  if (poItem) await pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE supplier_invoice_id = $1', [b.id, poItem]);
  return b;
}
/** A tool call in an OPEN request transaction (not committed): the caller commits it. */
async function openTool(tool: typeof link, args: Json) {
  const req = await openRequest(pool, f, f.owner);
  const ctx = { userId: f.owner, companyId: f.co, scopes: ['write:invoices', 'read:invoices', 'read:reports'], tokenJti: 'jti-b12', oauthAppId: null, companyRole: 'owner' } as never;
  const out = await req.run(() => tool.handler({ idempotency_key: `b12-${crypto.randomUUID()}`, ...args }, ctx));
  return { req, out };
}
const settle = <T>(p: Promise<T>, tag: string, out: string[]) =>
  p.then((v) => { out.push(`${tag} ok`); return v; }, (e: unknown) => { out.push(`${tag} threw ${(e as { code?: string }).code ?? ''} ${String(e).slice(0, 140)}`); return null; });

describe('F2 the link locks every bill that ties the PO', () => {
  for (const tie of ['header', 'lines'] as const) {
    for (const kind of ['cancel', 'softDelete', 'bulk'] as const) {
      it(`${kind} of B (${tie} tie on P, no link row) done but uncommitted: the link P<-X with close is refused retryably; after the commit it sees B gone and does not close P`, async () => {
        const p = await seedPo(pool, f, { lines: [1000] });
        const b = await approvedBill(600, tie === 'header' ? p.po : undefined, tie === 'lines' ? p.items[0] : undefined);
        const x = await approvedBill(400);
        const out: string[] = [];
        const c = await openRequest(pool, f, f.owner);
        try {
          if (kind === 'cancel') await settle(c.run(() => cancelSupplierInvoice(f.co, b.id, f.owner)), kind, out);
          else if (kind === 'softDelete') await settle(c.run(() => softDelete(f.co, 'supplier_invoice', b.id, f.owner)), kind, out);
          else {
            await c.run(() => lockPosClosedByBilling(f.co, [b.id]));
            await settle(c.run(() => withSavepoint('bulk_supplier_invoice_item', () => cancelSupplierInvoice(f.co, b.id, f.owner))), kind, out);
          }
          expect(out).toEqual([`${kind} ok`]);
          const args = { links: [{ po_id: p.po, bill_id: x.id, amount: 400 }], close_when_fully_billed: true };
          const attempt = () => callTool(pool, f, link, args).then((r) => `ok ${r.isError} ${r.text.slice(0, 60)}`, (e: unknown) => `threw ${(e as { code?: string }).code}`);
          // B's removal is done but uncommitted: the link must not read B as billing (it would close P); it is refused, never waits.
          expect(await attempt()).toBe('threw ROW_LOCK_TIMEOUT');
          // Then the cancel commits while the link runs: it is refused (NOWAIT) or reads B gone, never waits and never closes P.
          const [second] = await Promise.all([attempt(), c.commit()]);
          expect(second).toMatch(/^(threw ROW_LOCK_TIMEOUT|ok false )/);
          if (second.startsWith('threw')) expect(await attempt()).toMatch(/^ok false /);
        } catch (e) { await c.rollback(); throw e; }
        const s = await inv(p);
        expect([s.status, s.committedOk, s.statusOk]).toEqual(['approved', true, true]);
      }, 60_000);
    }
  }
});

describe('R12-D deadlocks with the late PO lock', () => {
  it('D1 cancel B (waits on B held by L0) vs unlink P/B (waits on P held by L0); L0 closes P and commits', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const b = await approvedBill(600);
    const x = await approvedBill(400);
    const l0 = await openTool(link, { links: [{ po_id: p.po, bill_id: b.id, amount: 600 }, { po_id: p.po, bill_id: x.id, amount: 400 }], close_when_fully_billed: true });
    expect(l0.out.isError).toBeFalsy();
    const out: string[] = [];
    const c = await openRequest(pool, f, f.owner);
    const cr = settle(c.run(() => cancelSupplierInvoice(f.co, b.id, f.owner)), 'cancel', out);
    expect(await waitLocked(1)).toBe(true);
    const u = settle(callTool(pool, f, unlink, { po_id: p.po, bill_id: b.id, reason: 'b12' }).then((r) => { out.push(`unlink isError=${r.isError} ${r.text.slice(0, 200)}`); return r; }), 'unlink', out);
    expect(await waitLocked(2)).toBe(true);
    const t0 = Date.now();
    await l0.req.commit();
    const cancelled = await cr as { uncheckedPurchaseOrders?: Array<{ poId: string }> } | null;
    await c.commit();
    await u;
    out.push(`elapsed ${Date.now() - t0}ms`);
    expect(out.join(' ')).not.toMatch(/deadlock|40P01/);
    // The unlink holds P when the cancel re-checks it (NOWAIT): P is left closed and the cancel says so (F5, accepted); committed
    // still counts its unbilled remainder, and get_purchase_order flags it closed under-billed.
    expect(cancelled?.uncheckedPurchaseOrders?.map((x) => x.poId)).toEqual([p.po]);
    const s = await inv(p);
    expect([s.committedOk, s.status, s.closed_under_billed]).toEqual([true, 'closed', true]);
  }, 60_000);

  it('D2 bulk pre-lock [B1, B2] waits on B2 held by L0 (closing P); L1 link P<-B1 waits on P; L0 commits', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const s1 = await approvedBill(300); const s2 = await approvedBill(300);
    const [b1, b2] = s1.id < s2.id ? [s1, s2] : [s2, s1];
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [b1.id, p.po]);
    await pool.query('UPDATE supplier_invoices SET purchase_order_id = NULL WHERE id = $1', [b2.id]);
    const x = await approvedBill(700);
    // b1 holds P by header: residual 300 (subtotal of b1). L0 links b2 (600) and x (100 of 700) to P: 300 + 600 + 100 = 1000 -> closes.
    const l0 = await openTool(link, { links: [{ po_id: p.po, bill_id: b2.id, amount: 300 }, { po_id: p.po, bill_id: x.id, amount: 400 }], close_when_fully_billed: true });
    expect(l0.out.isError, l0.out.content[0]!.text).toBeFalsy();
    const out: string[] = [];
    const bulk = await openRequest(pool, f, f.owner);
    const ordered = [b1.id, b2.id].sort();
    const pre = settle(bulk.run(() => lockPosClosedByBilling(f.co, ordered)), 'bulk pre-lock', out);
    await pre; // the PO rows only (P is not closed yet): it waits on nothing now
    const l1 = settle(callTool(pool, f, link, { links: [{ po_id: p.po, bill_id: b1.id, amount: 300 }] }).then((r) => { out.push(`L1 isError=${r.isError} ${r.text.slice(0, 200)}`); return r; }), 'L1', out);
    expect(await waitLocked(1)).toBe(true);
    const t0 = Date.now();
    await l0.req.commit();
    const preMap = await pre as Map<string, number> | null;
    out.push(`pre-lock map ${JSON.stringify(preMap ? [...preMap] : null)} after ${Date.now() - t0}ms`);
    for (const id of ordered) {
      await settle(bulk.run(() => withSavepoint('bulk_supplier_invoice_item', () => cancelSupplierInvoice(f.co, id, f.owner))), `bulk item ${id === b1.id ? 'b1' : 'b2'}`, out);
    }
    await bulk.commit();
    await l1;
    out.push(`elapsed ${Date.now() - t0}ms`);
    expect(out.join(' ')).not.toMatch(/deadlock|40P01/);
    const s = await inv(p);
    expect(s.committedOk).toBe(true);
    expect(s.statusOk).toBe(true);
  }, 60_000);
});

describe('F1 bulk cancel with one held bill', () => {
  it('3 bills, the middle one held by another transaction: 200, two cancelled, the held one a per-item failure', async () => {
    const ids: string[] = [];
    for (const a of [100, 200, 300]) { const b = await seedBill(pool, f, { status: 'draft', lines: [a] }); await approveBill(pool, f, b.id); ids.push(b.id); }
    ids.sort();
    const h = await pool.connect();
    let out: Awaited<ReturnType<typeof callRoute>>;
    try {
      await h.query('BEGIN'); await h.query('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [ids[1]]);
      out = await callRoute(bulkRoute as never, f, f.owner, '/api/accounting/supplier-invoices-bulk-action', { action: 'cancel', invoiceIds: ids });
    } finally { await h.query('ROLLBACK'); h.release(); }
    const st = (await pool.query('SELECT id, status FROM supplier_invoices WHERE id = ANY($1::UUID[]) ORDER BY id', [ids])).rows.map((r) => r.status);
    expect([out.statusCode, st]).toEqual([200, ['cancelled', 'approved', 'cancelled']]);
  }, 60_000);
});

describe('F4 the signed header transfer', () => {
  for (const dry of [true, false]) {
    it(`H R1050 header of bill b (L1 +300 -> A, L2 -100 free, L3 +800 free; sub 1000); call [A<-b lines L2], [H<-y 300] close (dry=${dry})`, async () => {
      const H = await seedPo(pool, f, { lines: [1050] });
      const A = await seedPo(pool, f, { lines: [500] });
      const b = await seedRawBill(pool, f, { items: [{ total: 300, poItem: A.items[0] }, { total: -100 }, { total: 800 }], subtotal: 1000, total: 1150, header: H.po });
      const y = await seedRawBill(pool, f, { items: [{ total: 300 }], subtotal: 300, total: 345 });
      const before = await billedCentsByPo(f.co, [H.po, A.po]);
      const r = await callTool(pool, f, link, { links: [{ po_id: A.po, bill_id: b.id, lines: [{ po_item_id: A.items[0], bill_line_id: b.lines[1] }] }, { po_id: H.po, bill_id: y.id, amount: 300 }], close_when_fully_billed: true, dry_run: dry });
      const after = await billedCentsByPo(f.co, [H.po, A.po]);
      const st = (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [H.po])).rows[0];
      const reply = r.body as { purchase_orders?: Array<{ po_number: string; billed: number; fully_billed: boolean; status: string }>; budget_warnings?: string[] };
      const hReply = reply.purchase_orders?.find((p) => p.po_number === H.number);
      expect([r.isError, Math.round((hReply?.billed ?? 0) * 100), hReply?.fully_billed, hReply?.status]).toEqual([false, 110000, true, 'closed']);
      if (!dry) expect([after.get(H.po.toLowerCase()), st]).toEqual([110000, { status: 'closed', closed_by_billing: true }]);
      void before;
    }, 60_000);
  }
});

const cents = (n: number) => Math.round(n * 100);
const fully = (b: number, basis: number) => basis > 0 && b > 0 && b >= basis - 1;

describe('R12-P planner vs reader, randomised', () => {
  it('random POs / bills / ties, two link calls (the second closing)', async () => {
    let seed = 1;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    const poPal = [0.01, 1, 100, 250.5, 500, 1000];
    const linePal = [-200, -0.01, 0.01, 50, 100, 300, 600, 1000];
    const bad: unknown[] = [];
    let calls = 0, ok = 0, closes = 0, takes = 0;
    for (let k = 0; k < 40; k++) {
      const pos: SeededPo[] = [];
      for (let i = 0; i < 3; i++) pos.push(await seedPo(pool, f, { lines: Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(poPal)) }));
      const [H] = pos;
      const bills: Array<{ id: string; lines: string[]; named: Array<string | null> }> = [];
      for (let b = 0; b < 1 + Math.floor(rnd() * 3); b++) {
        const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ total: pick(linePal), poItem: rnd() < 0.35 ? pick(pick(pos).items) : null as string | null }));
        let sub = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
        if (sub <= 0) { const add = Math.round((-sub + pick([0.01, 100, 500])) * 100) / 100; items.push({ total: add, poItem: null }); sub = Math.round((sub + add) * 100) / 100; }
        const header = rnd() < 0.6 ? H!.po : rnd() < 0.3 ? pick(pos).po : null;
        const sb = await seedRawBill(pool, f, { items, subtotal: sub, total: Math.round(sub * 115) / 100, header });
        bills.push({ id: sb.id, lines: sb.lines, named: items.map((i) => i.poItem) });
      }
      const mkRows = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
        const po = pick(pos); const bill = pick(bills);
        const row: Record<string, unknown> = { po_id: po.po, bill_id: bill.id };
        const r = rnd();
        if (r < 0.4) { /* no amount */ } else row.amount = pick([0.01, 1, 50, 100, 250.5, 300, 600, 999.99, 1000]);
        if (rnd() < 0.3) {
          const free = bill.lines.filter((_, i) => bill.named[i] === null);
          if (free.length > 0) row.lines = [{ po_item_id: pick(po.items), bill_line_id: pick(free) }];
        }
        return row;
      });
      const ids = pos.map((p) => p.po.toLowerCase());
      for (const phase of [0, 1]) {
        let rows = mkRows();
        const close = phase === 1 || rnd() < 0.3;
        const before = await billedCentsByPo(f.co, ids);
        let dry = await callTool(pool, f, link, { links: rows, close_when_fully_billed: close, dry_run: true });
        for (let t = 0; t < 3 && dry.isError && rows.length > 0; t++) {
          const badIdx = new Set([...dry.text.matchAll(/links\[(\d+)\]:/g)].map((m) => Number(m[1])));
          if (badIdx.size === 0) break;
          rows = rows.filter((_, i) => !badIdx.has(i));
          if (rows.length === 0) break;
          dry = await callTool(pool, f, link, { links: rows, close_when_fully_billed: close, dry_run: true });
        }
        if (rows.length === 0 || dry.isError) { calls++; continue; }
        const res = await callTool(pool, f, link, { links: rows, close_when_fully_billed: close });
        calls++;
        if (res.isError) { bad.push({ k, phase, problems: ['dry ok, real refused'], text: res.text.slice(0, 300) }); continue; }
        ok++;
        for (const [i, r] of rows.entries()) if (r.lines) { const bl = bills.find((b) => b.id === r.bill_id)!; const j = bl.lines.indexOf((r.lines as Array<{ bill_line_id: string }>)[0]!.bill_line_id); if (j >= 0) bl.named[j] = (r.lines as Array<{ po_item_id: string }>)[0]!.po_item_id; void i; }
        const after = await billedCentsByPo(f.co, ids);
        const basis = await poBillingBasisCents(f.co, ids);
        const committed = await poCommittedCents(f.co, ids);
        const reply = res.body as { purchase_orders: Array<{ id: string; status_before: string; status: string; closed_by_this_call: boolean; billed: number; fully_billed: boolean }>; budget_warnings: string[] };
        if (/takes|took|header/i.test(JSON.stringify(reply.budget_warnings))) takes++;
        const problems: string[] = [];
        if (JSON.stringify((dry.body as typeof reply).purchase_orders?.map((p) => [p.id, p.status, p.billed])) !== JSON.stringify(reply.purchase_orders.map((p) => [p.id, p.status, p.billed]))) problems.push('dry_run differs');
        for (const p of reply.purchase_orders) {
          const id = p.id.toLowerCase();
          const rb = after.get(id) ?? 0; const bs = basis.get(id) ?? 0;
          if (cents(p.billed) !== rb) problems.push(`${id.slice(0, 4)} reply billed ${cents(p.billed)} != reader ${rb}`);
          if (p.closed_by_this_call) { closes++; if (!fully(rb, bs)) problems.push(`${id.slice(0, 4)} CLOSED but reader billed ${rb} of basis ${bs}`); }
          if (close && !p.closed_by_this_call && ['approved', 'partially_received', 'received'].includes(p.status_before) && fully(rb, bs)) problems.push(`${id.slice(0, 4)} left OPEN but reader fully billed ${rb} of ${bs}`);
          if (p.fully_billed !== fully(rb, bs)) problems.push(`${id.slice(0, 4)} fully_billed ${p.fully_billed} != reader`);
        }
        for (const id of ids) {
          const st = (await pool.query('SELECT status, closed_by_billing FROM purchase_orders WHERE id = $1', [id])).rows[0];
          const commits = ['approved', 'partially_received', 'received'].includes(st.status) || (st.status === 'closed' && st.closed_by_billing);
          if (!commits && (committed.get(id) ?? 0) !== 0) problems.push(`${id.slice(0, 4)} commits while ${st.status}`);
          void before;
        }
        if (problems.length) bad.push({ k, phase, problems, rows: rows.map((r) => ({ po: ids.indexOf(String(r.po_id).toLowerCase()), bill: bills.findIndex((b) => b.id === r.bill_id), amount: r.amount ?? null, lines: !!r.lines })), reply: reply.purchase_orders, before: [...before], after: [...after], basis: [...basis] });
      }
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
