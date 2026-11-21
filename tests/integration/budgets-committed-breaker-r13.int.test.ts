/**
 * PR #1703, ledger breaker round 13 (ported from its zz-b13 repros at c0ff1b11a6), real PostgreSQL 16. The link takes the bills
 * that tie its POs only by header or lines FOR SHARE NOWAIT, in one statement, after its FOR UPDATE bills:
 *   #1  an MCP batch that edits two tied draft bills out of id order no longer deadlocks with a link (40P01 4/4 at c0ff);
 *   #3  a held tied bill refuses the link at once, retryably (`ROW_LOCK_TIMEOUT`, it named the PO), not after the 5 s budget;
 *       a cancelled tied bill is terminal and not taken at all.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { callTool, type Json } from './helpers/poImportHarness';
import { approveBill, seedBill, seedPo, type SeededPo } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { updateSupplierInvoiceTool as editTool } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { withSavepoint } from '@/lib/neon';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 14 });
let f: BillFixture;
beforeAll(async () => { f = await seedBillFixture(pool, 'brk-r13'); await setPolicy(pool, f, 'warn'); }, 60_000);
afterAll(async () => { try { await dropBillFixture(pool, f); } finally { await pool.end(); } }, 60_000);

/** Far under the 5 s row-lock budget: the refusal took no lock wait. */
const FAST_MS = 2000;
const busyText = (po: SeededPo) => `A bill tied to purchase order ${po.number} is being changed right now; retry in a moment.`;
const ctx = () => ({ userId: f.owner, companyId: f.co, scopes: ['write:invoices', 'read:invoices'], tokenJti: 'b13', oauthAppId: null, companyRole: 'owner' }) as never;

async function bill(amount: number, opts: { approved?: boolean; header?: string; poItem?: string } = {}) {
  const b = await seedBill(pool, f, { status: 'draft', lines: [amount] });
  if (opts.approved !== false) await approveBill(pool, f, b.id);
  await pool.query('DELETE FROM purchase_order_bill_links WHERE supplier_invoice_id = $1', [b.id]);
  if (opts.header) await pool.query('UPDATE supplier_invoices SET purchase_order_id = $2 WHERE id = $1', [b.id, opts.header]);
  if (opts.poItem) await pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE supplier_invoice_id = $1', [b.id, opts.poItem]);
  return b;
}
/** The link, timed; a refusal is its typed error (the MCP boundary answers ROW_LOCK_TIMEOUT verbatim, retryable). */
async function timedLink(args: Json): Promise<{ ms: number; ok: boolean; code?: string; message?: string }> {
  const t0 = Date.now();
  try {
    const r = await callTool(pool, f, link, args);
    if (r.isError) return { ms: Date.now() - t0, ok: false, message: r.text };
    return { ms: Date.now() - t0, ok: true };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, code: (e as { code?: string }).code, message: String((e as Error).message) };
  }
}
/** A plain UPDATE of the bill row (a payment, a due-date edit), held; released after `ms` at the latest so a waiting link cannot hang. */
async function holdBill(id: string, ms = 4000): Promise<{ release: () => Promise<void> }> {
  const h: PoolClient = await pool.connect();
  await h.query('BEGIN');
  await h.query('UPDATE supplier_invoices SET updated_at = NOW() WHERE id = $1', [id]);
  let done = false;
  const release = async () => { if (done) return; done = true; await h.query('ROLLBACK').catch(() => undefined); h.release(); };
  setTimeout(() => { void release(); }, ms);
  return { release };
}

describe('#3 a held tied bill refuses the link at once, retryably', () => {
  for (const kind of ['approved-header', 'deleted-header', 'draft-lines', 'approve-in-flight', 'dry-run'] as const) {
    it(`${kind}: refused fast, naming the PO; nothing written; the link succeeds once the bill is free`, async () => {
      const p = await seedPo(pool, f, { lines: [1000] });
      const x = await bill(300);
      let release: () => Promise<void>;
      if (kind === 'approve-in-flight') {
        const d = await bill(100, { approved: false, header: p.po });
        const h = await openRequest(pool, f, f.owner);
        await h.run(() => approveSupplierInvoice(f.co, d.id, f.owner));
        release = () => h.rollback();
      } else {
        const b = kind === 'draft-lines' ? await bill(100, { approved: false, poItem: p.items[0] }) : await bill(100, { header: p.po });
        if (kind === 'deleted-header') await pool.query('UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = $1', [b.id]);
        release = (await holdBill(b.id)).release;
      }
      const args: Json = { links: [{ po_id: p.po, bill_id: x.id, amount: 300 }], ...(kind === 'dry-run' ? { dry_run: true } : {}) };
      let r: Awaited<ReturnType<typeof timedLink>>;
      try { r = await timedLink(args); } finally { await release(); }
      expect([r.ok, r.code, r.message]).toEqual([false, 'ROW_LOCK_TIMEOUT', busyText(p)]);
      expect(r.ms).toBeLessThan(FAST_MS);
      expect((await pool.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE purchase_order_id = $1', [p.po])).rows[0].n).toBe(0);
      expect((await timedLink({ links: [{ po_id: p.po, bill_id: x.id, amount: 300 }] })).ok).toBe(true);
    }, 60_000);
  }

  it('a cancelled tied bill is terminal and not taken: a held one does not refuse the link', async () => {
    const p = await seedPo(pool, f, { lines: [1000] });
    const x = await bill(300);
    const b = await bill(100, { header: p.po });
    await pool.query("UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1", [b.id]);
    const { release } = await holdBill(b.id);
    let r: Awaited<ReturnType<typeof timedLink>>;
    try { r = await timedLink({ links: [{ po_id: p.po, bill_id: x.id, amount: 300 }] }); } finally { await release(); }
    expect([r.ok, r.message]).toEqual([true, undefined]);
    expect(r.ms).toBeLessThan(FAST_MS);
  }, 60_000);
});

describe('#1 no deadlock with an unsorted writer of two tied bills', () => {
  for (let run = 0; run < 4; run++) {
    it(`MCP batch [edit B_hi, edit B_lo] vs a link on P, run ${run}: the link refuses at once, the batch completes`, async () => {
      const p = await seedPo(pool, f, { lines: [1000] });
      const d1 = await bill(100, { approved: false, header: p.po }); const d2 = await bill(100, { approved: false, header: p.po });
      const [lo, hi] = d1.id < d2.id ? [d1, d2] : [d2, d1];
      const x = await bill(400);
      const out: string[] = [];
      const w = await openRequest(pool, f, f.owner);
      const edit = async (id: string, tag: string) => {
        try {
          const r = await withSavepoint(`mcp_${tag}`, () => editTool.handler({ invoice_id: id, notes: `b13 ${tag}` }, ctx()));
          out.push(`${tag} isError=${r.isError === true}`);
        } catch (e) { out.push(`${tag} threw ${(e as { code?: string }).code ?? ''} ${String(e).slice(0, 80)}`); }
      };
      let linked: Awaited<ReturnType<typeof timedLink>>;
      try {
        await w.run(() => edit(hi.id, 'edit_hi'));
        linked = await timedLink({ links: [{ po_id: p.po, bill_id: x.id, amount: 400 }] });
        await w.run(() => edit(lo.id, 'edit_lo'));
        await w.commit();
      } catch (e) { await w.rollback(); throw e; }
      expect(out).toEqual(['edit_hi isError=false', 'edit_lo isError=false']);
      expect([linked.ok, linked.code, linked.message]).toEqual([false, 'ROW_LOCK_TIMEOUT', busyText(p)]);
      expect(linked.ms).toBeLessThan(FAST_MS);
      expect((await timedLink({ links: [{ po_id: p.po, bill_id: x.id, amount: 400 }] })).ok).toBe(true);
    }, 60_000);
  }

  for (let run = 0; run < 4; run++) {
    it(`a plain writer holding B_hi, then B_lo, vs the link, run ${run}: no 40P01`, async () => {
      const p = await seedPo(pool, f, { lines: [1000] });
      const s1 = await bill(100, { header: p.po }); const s2 = await bill(100, { header: p.po });
      const [lo, hi] = s1.id < s2.id ? [s1, s2] : [s2, s1];
      const x = await bill(300);
      const w = await pool.connect();
      const out: string[] = [];
      try {
        await w.query('BEGIN');
        await w.query('UPDATE supplier_invoices SET updated_at = NOW() WHERE id = $1', [hi.id]);
        const r = await timedLink({ links: [{ po_id: p.po, bill_id: x.id, amount: 300 }] });
        out.push(`link ok=${r.ok} ${r.code ?? ''}`);
        await w.query('UPDATE supplier_invoices SET updated_at = NOW() WHERE id = $1', [lo.id]).then(() => out.push('writer ok'), (e: unknown) => out.push(`writer threw ${(e as { code?: string }).code}`));
      } finally { await w.query('ROLLBACK').catch(() => undefined); w.release(); }
      expect(out).toEqual(['link ok=false ROW_LOCK_TIMEOUT', 'writer ok']);
    }, 60_000);
  }
});
