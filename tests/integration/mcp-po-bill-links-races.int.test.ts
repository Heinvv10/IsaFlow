/**
 * Purchase order <-> bill links under concurrency and failure (design docs/design/mcp-po-bill-links.md, decision 13 and
 * the lock-order census), real PostgreSQL, as app_user:
 *   - the same pair, or one external_ref on pairs of different POs, from calls at once: one link, clean refusals, never a
 *     unique violation; two calls naming two references in opposite orders never deadlock;
 *   - a PO or a bill held by another request ends in the typed, retryable timeout with nothing written; so does a bill held
 *     only because ANOTHER link of the PO names it (the close decision locks those too);
 *   - the write guards that cannot fire under the locks, forced by a trigger that skips the row: a bill line that changes
 *     while it is linked, a PO that changes while it is closed or reopened, each throw and leave nothing behind;
 *   - a draft edit (holding its bill, then taking the PO's KEY SHARE through the link's FK) against a link / unlink call (holding the PO,
 *     then waiting for that bill): no deadlock, because the PO is taken FOR NO KEY UPDATE (review round 2, M1); since PR #1703 r14 M3
 *     the link takes a bill it does not link (a tie of its PO) FOR SHARE NOWAIT, so it refuses at once, retryably, and the retry links;
 *   - link x unlink x PO cancel x bill approve / cancel x draft edit on the same rows under the block policy (the budget gate taken):
 *     no deadlock, no unexpected rejection, and the final state is consistent.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool } from './helpers/poImportHarness';
import { approveBill, lineLinks, linkRows, poStatus, seedBill, seedPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { updateSupplierInvoiceTool as updateBill } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { refreshAppBillLinks } from '@/modules/accounting/services/ap/billPurchaseOrderLinks';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { approveSupplierInvoice, cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { cancelApprovedPurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderCancel';
import { PurchaseOrderNotCancellableError } from '@/modules/accounting/services/ap/purchaseOrderErrors';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-links-races');
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

describe('races', () => {
  it('the same pair from two calls at once: one link, one clean "already linked"', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const results = await Promise.all([1, 2, 3].map(() => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    for (const r of results.filter((x) => x.isError)) expect(r.text).toContain('is already linked to purchase order');
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);
  });

  it('one external_ref on two pairs of DIFFERENT POs at once (only the reference lock joins them): one link, one clean refusal, never a unique violation', async () => {
    const pos = [await seedPo(pool, f, { lines: [100] }), await seedPo(pool, f, { lines: [100] })];
    const bills = [await seedBill(pool, f, { lines: [100] }), await seedBill(pool, f, { lines: [100] })];
    const ref = { external_system: 'sage', external_ref: 'RACE-1' };
    const results = await Promise.all([0, 1].map((i) => callTool(pool, f, link, { links: [{ po_id: pos[i]!.po, bill_id: bills[i]!.id, ...ref }] })));
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.find((r) => r.isError)!.text).toContain('is already used by another purchase order link');
  });

  it('two calls naming two references in OPPOSITE orders, on pairs of different POs, never deadlock (the reference locks are taken sorted)', async () => {
    for (let round = 0; round < 6; round++) {
      const pos = [await seedPo(pool, f, { lines: [100] }), await seedPo(pool, f, { lines: [100] }), await seedPo(pool, f, { lines: [100] }), await seedPo(pool, f, { lines: [100] })];
      const bills = [await seedBill(pool, f, { lines: [100] }), await seedBill(pool, f, { lines: [100] }), await seedBill(pool, f, { lines: [100] }), await seedBill(pool, f, { lines: [100] })];
      const ref = (n: number) => ({ external_system: 'sage', external_ref: `OPP-${round}-${n}` });
      const results = await Promise.allSettled([
        callTool(pool, f, link, { links: [{ po_id: pos[0]!.po, bill_id: bills[0]!.id, ...ref(1) }, { po_id: pos[1]!.po, bill_id: bills[1]!.id, ...ref(2) }] }),
        callTool(pool, f, link, { links: [{ po_id: pos[3]!.po, bill_id: bills[3]!.id, ...ref(2) }, { po_id: pos[2]!.po, bill_id: bills[2]!.id, ...ref(1) }] }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const done = results.map((r) => (r as PromiseFulfilledResult<{ isError: boolean; text: string }>).value);
      expect(done.filter((r) => !r.isError)).toHaveLength(1);
      expect(done.find((r) => r.isError)!.text).toContain('is already used by another purchase order link');
    }
  }, 120_000);

  async function held(sqlText: string, params: unknown[], during: () => Promise<unknown>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sqlText, params);
      return await during().then((v) => ({ v }), (e: unknown) => ({ e }));
    } finally { await c.query('ROLLBACK'); c.release(); }
  }

  it('a PO or a bill held by another request ends in a typed retryable timeout and nothing is written', async () => {
    const po = await seedPo(pool, f, { lines: [100] });
    const bill = await seedBill(pool, f, { lines: [100] });
    const call = () => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    const poHeld = await held('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po], call);
    expect((poHeld as { e: { code: string } }).e).toMatchObject({ code: 'PURCHASE_ORDER_LOCK_TIMEOUT' });
    const billHeld = await held('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill.id], call);
    expect((billHeld as { e: { code: string } }).e).toMatchObject({ code: 'ROW_LOCK_TIMEOUT' });
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    const ok = await call();
    expect(ok.isError, ok.text).toBe(false);
  }, 60_000);

  it('a bill held only because another link of the PO names it also ends in the retryable timeout (the close decision locks it)', async () => {
    const po = await seedPo(pool, f, { lines: [100, 100] });
    const b1 = await seedBill(pool, f, { lines: [100] });
    const b2 = await seedBill(pool, f, { lines: [100] });
    await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b1.id }] });
    const call = () => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: b2.id }], close_when_fully_billed: true });
    const heldB1 = await held('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [b1.id], call);
    expect((heldB1 as { e: { code: string } }).e).toMatchObject({ code: 'ROW_LOCK_TIMEOUT' });
    expect(await linkRows(pool, f, `l.supplier_invoice_id = '${b2.id}'`)).toEqual([]);
    expect(await poStatus(pool, po.po)).toBe('approved');
    const unlinkCall = () => callTool(pool, f, unlink, { po_id: po.po, bill_id: b2.id, reason: 'x' });
    const heldPo = await held('SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.po], unlinkCall);
    expect((heldPo as { e: { code: string } }).e).toMatchObject({ code: 'PURCHASE_ORDER_LOCK_TIMEOUT' });
  }, 60_000);

  /** Makes UPDATEs of `table` rows matching `where` do nothing (the trigger returns NULL): a write guard that cannot fire under the locks, forced. */
  async function skipUpdates(table: string, where: string, during: () => Promise<unknown>) {
    await pool.query(`CREATE OR REPLACE FUNCTION pg_temp_skip_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${where} THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER zz_skip BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_temp_skip_${table}()`);
    try { return await during().then((v) => ({ v }), (e: unknown) => ({ e })); } finally {
      await pool.query(`DROP TRIGGER zz_skip ON ${table}`);
      await pool.query(`DROP FUNCTION pg_temp_skip_${table}()`);
    }
  }

  it('the re-checks that cannot fire under the locks throw and leave nothing behind (a bill line, the PO close, the PO reopen)', async () => {
    const po = await seedPo(pool, f, { lines: [100], status: 'received' });
    const bill = await seedBill(pool, f, { lines: [100] });
    const withLines = () => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id, lines: [{ po_item_id: po.items[0], bill_line_id: bill.lines[0] }] }] });
    const lineGone = await skipUpdates('supplier_invoice_items', `OLD.supplier_invoice_id = '${bill.id}'`, withLines);
    expect(String((lineGone as { e: Error }).e)).toContain('A bill line changed while it was being linked');
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    expect(await lineLinks(pool, bill.id)).toEqual([null]);

    const closing = () => callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }], close_when_fully_billed: true });
    const closeGone = await skipUpdates('purchase_orders', `OLD.id = '${po.po}'`, closing);
    expect(String((closeGone as { e: Error }).e)).toContain('The purchase order changed while it was being closed');
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toEqual([]);
    expect(await poStatus(pool, po.po)).toBe('received');

    expect((await closing()).isError).toBe(false);
    expect(await poStatus(pool, po.po)).toBe('closed');
    const reopening = () => callTool(pool, f, unlink, { po_id: po.po, bill_id: bill.id, reason: 'x' });
    const reopenGone = await skipUpdates('purchase_orders', `OLD.id = '${po.po}'`, reopening);
    expect(String((reopenGone as { e: Error }).e)).toContain('The purchase order changed while it was being reopened');
    expect(await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`)).toHaveLength(1);
    expect(await poStatus(pool, po.po)).toBe('closed');
  });

  it('M1: a draft edit holding its bill, then taking the PO\'s KEY SHARE through the link FK, never deadlocks with a link or unlink call that holds the PO and waits for that bill', async () => {
    for (const leg of ['link', 'unlink'] as const) {
      const po = await seedPo(pool, f, { lines: [100, 100] });
      const draft = await seedBill(pool, f, { lines: [50], status: 'draft' });
      const approved = await seedBill(pool, f, { lines: [100] });
      await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 50, 'app')", [f.co, po.po, draft.id]);
      await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [draft.id, po.po]);
      if (leg === 'unlink') await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: approved.id }] });
      // The draft edit: its bill row is held and its subtotal moved, so the refresh must delete and make the link again.
      const edit = await openRequest(pool, f, f.owner);
      await edit.client.query('SELECT 1 FROM supplier_invoices WHERE id = $1 FOR UPDATE', [draft.id]);
      await edit.client.query('UPDATE supplier_invoices SET subtotal = 40 WHERE id = $1', [draft.id]);
      // The other call takes the PO, then waits for the draft's row (an existing link of the PO).
      const other = leg === 'link'
        ? callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: approved.id }] })
        : callTool(pool, f, unlink, { po_id: po.po, bill_id: approved.id, reason: 'race' });
      await new Promise((r) => setTimeout(r, 800));
      let refreshed: unknown;
      try { refreshed = await edit.run(() => refreshAppBillLinks(f.co, draft.id, f.owner)); await edit.commit(); } catch (e) { await edit.rollback(); refreshed = e; }
      const done = await Promise.allSettled([other]);
      expect(refreshed, `${leg}: the draft edit's refresh`).toBe(1);
      if (leg === 'link') {
        // PR #1703 r14 M3: the draft is a tie of the PO the link does not link: taken NOWAIT, busy, so the call is refused at once.
        expect(done[0]!.status, 'link: refused, never waiting').toBe('rejected');
        expect((done[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ROW_LOCK_TIMEOUT', name: 'TiedBillBusyError' });
        expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: approved.id }] })).isError, 'link: the retry').toBe(false);
      } else {
        expect(done[0]!.status, `${leg}: the other call`).toBe('fulfilled');
        expect((done[0] as PromiseFulfilledResult<{ isError: boolean; text: string }>).value.isError, `${leg}`).toBe(false);
      }
      expect((await linkRows(pool, f, `l.supplier_invoice_id = '${draft.id}'`))[0]).toMatchObject({ amount: '40.00', source: 'app' });
    }
  }, 60_000);

  it('lock-order census in motion: link x unlink x PO cancel x bill approve / cancel on the same rows under block (the gate taken) never deadlock; the end state is consistent', async () => {
    try {
      const inRequest = async (fn: () => Promise<unknown>) => {
        const req = await openRequest(pool, f, f.owner);
        try { const v = await req.run(fn); await req.commit(); return v; } catch (e) { await req.rollback(); throw e; }
      };
      const unexpected: string[] = [];
      for (let i = 0; i < 10; i++) {
        const po = await seedPo(pool, f, { lines: [100] });
        // Really approved (journal posted), so that cancelling one reverses it.
        const linkedBill = await seedBill(pool, f, { lines: [100], status: 'draft' });
        const racing = await seedBill(pool, f, { lines: [100], status: 'draft' });
        // The bill approved in the race is on an unbudgeted account, so the block policy never refuses it.
        const draft = { id: await makeBill(pool, f, [{ acct: f.acc.nob, amount: 50 }], { status: 'draft' }) };
        await approveBill(pool, f, linkedBill.id);
        await approveBill(pool, f, racing.id);
        // A draft bill that already carries an app link to the PO: its edit (holds the bill, then the link FK's KEY SHARE on the PO).
        const editing = await seedBill(pool, f, { lines: [100], status: 'draft' });
        await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 100, 'app')", [f.co, po.po, editing.id]);
        await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [editing.id, po.po]);
        await setPolicy(pool, f, 'block');
        await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: linkedBill.id }] });
        const ops: Array<[string, Promise<unknown>]> = [
          ['link', callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: racing.id }], close_when_fully_billed: true })],
          ['unlink', callTool(pool, f, unlink, { po_id: po.po, bill_id: linkedBill.id, reason: 'race' })],
          ['cancel PO', inRequest(() => cancelApprovedPurchaseOrder(f.co, po.po, f.owner, 'race'))],
          ['approve', inRequest(() => approveSupplierInvoice(f.co, draft.id, f.owner))],
          ['draft edit', callTool(pool, f, updateBill, { invoice_id: editing.id, lines: [{ description: 'edited', quantity: 1, unit_price: 40 + i, tax_rate: 0, gl_account_id: f.acc.opex }] })],
          [i % 2 === 0 ? 'cancel bill' : 'cancel linked bill', inRequest(() => cancelSupplierInvoice(f.co, i % 2 === 0 ? racing.id : linkedBill.id, f.owner))],
        ];
        const settled = await Promise.allSettled(ops.map(([, p]) => p));
        await setPolicy(pool, f, 'warn');
        settled.forEach((r, k) => {
          if (r.status === 'fulfilled') return;
          const err = r.reason as Error;
          // The refusals a race may legitimately produce: the PO was closed or cancelled by another call first; the link found a
          // bill tying its PO busy (PR #1703 r13 / r14 M3: taken NOWAIT, refused at once and retryably, never a wait or a 40P01).
          if (ops[k]![0] === 'link' && (err as { name?: string }).name === 'TiedBillBusyError') return;
          if (!(err instanceof PurchaseOrderNotCancellableError)) unexpected.push(`${ops[k]![0]}: ${(err as { code?: string }).code ?? ''} ${err.message}`);
        });
        const links = await linkRows(pool, f, `l.purchase_order_id = '${po.po}'`);
        const edited = links.find((l) => l.bill === editing.id);
        if (edited) expect(Number(edited.amount), 'the draft\'s link follows its edit').toBe(40 + i);
        expect(new Set(links.map((l) => l.bill)).size, 'a pair is linked once').toBe(links.length);
        const status = await poStatus(pool, po.po);
        expect(['approved', 'closed', 'cancelled']).toContain(status);
        // Only the link tool closes a PO here: a closed PO carries its closing record on itself (PR #1703 R4-1), never on a link.
        const rec = (await pool.query('SELECT closed_by_billing, closed_from_status FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
        expect(rec.closed_by_billing, 'closed by a link: the record is on the PO, and only while closed').toBe(status === 'closed');
        expect(rec.closed_from_status !== null, 'closed_from_status only while closed').toBe(status === 'closed');
        expect(links.every((l) => l.closed_po_from_status === null), 'no record on a link').toBe(true);
        expect(String((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [draft.id])).rows[0].status)).toBe('approved');
      }
      expect(unexpected).toEqual([]);
    } finally {
      await setPolicy(pool, f, 'warn');
    }
  }, 180_000);
});
