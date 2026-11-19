/**
 * The PO maintenance tools' fences (docs/design/mcp-po-maintenance.md), real PostgreSQL, as app_user (poImportHarness):
 *   - every tool reads another company's PO (by id and by number) as "Not found", live and dry run, and changes nothing there;
 *   - a dry run of every tool changes nothing (PO, lines, audit rows, ledger) and marks the call write-free, so the key stays free;
 *   - none of them writes a ledger row when it succeeds;
 *   - the tools post nothing to a company the caller is not in even when the PO id is guessed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { auditOf, callTool, dropMaintExtras, glCount, poLines, poRow, seedGrn, seedQtyPo, type Json } from './helpers/poMaintHarness';
import { seedBill } from './helpers/poBillLinkHarness';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { closePurchaseOrderTool as close } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import type { McpTool } from '@/lib/mcp/types';
import { als } from '@/lib/als';
import { resolvePoId } from '@/lib/mcp/tools/purchaseOrderMaintenanceArgs';
import { updatePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderUpdate';
import { cancelPurchaseOrder, closePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderMaintenance';
import { setImportedPurchaseOrderStatus } from '@/modules/accounting/services/ap/purchaseOrderSetStatus';
import { lockPoForMaintenance, poBillTie, poHasReceipts } from '@/modules/accounting/services/ap/purchaseOrderMaintenanceGuards';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-maint-fences');
  other = await seedBillFixture(pool, 'po-maint-fences-other');
  await setPolicy(pool, f, 'warn');
  await setPolicy(pool, other, 'warn');
}, 60_000);
afterAll(async () => {
  try { for (const x of [f, other]) { await dropMaintExtras(pool, x); await dropBillFixture(pool, x); } } finally { await pool.end(); }
}, 60_000);

const line = (acct: string) => ({ description: 'x', quantity: 1, unit_price: 5, tax_rate: 0, gl_account_id: acct });
const TOOLS: Array<[string, McpTool, (sel: Json) => Json]> = [
  ['update_purchase_order', update, (sel) => ({ ...sel, notes: 'hijack', lines: [line(f.acc.opex)] })],
  ['cancel_purchase_order', cancel, (sel) => ({ ...sel, reason: 'hijack' })],
  ['close_purchase_order', close, (sel) => ({ ...sel, reason: 'hijack' })],
  ['set_purchase_order_status', setStatus, (sel) => ({ ...sel, status: 'cancelled', reason: 'hijack' })],
];

describe('another company\'s PO', () => {
  it.each(TOOLS)('%s reads it as "Not found" by id and by number, live and dry run, and changes nothing', async (_name, tool, args) => {
    const theirs = await seedQtyPo(pool, other, { external: true, lines: [{ qty: 1, price: 100 }] });
    const before = { po: await poRow(pool, theirs.po), lines: await poLines(pool, theirs.po), audit: await auditOf(pool, other, theirs.po) };
    for (const sel of [{ po_id: theirs.po }, { po_number: theirs.number }]) {
      for (const dry of [false, true]) {
        const r = await callTool(pool, f, tool, { ...args(sel), ...(dry ? { dry_run: true } : {}) });
        expect(r, `${JSON.stringify(sel)} dry=${dry}`).toMatchObject({ isError: true, text: 'Not found' });
      }
    }
    expect({ po: await poRow(pool, theirs.po), lines: await poLines(pool, theirs.po), audit: await auditOf(pool, other, theirs.po) }).toEqual(before);
  });

  it('a PO that does not exist reads the same', async () => {
    for (const [, tool, args] of TOOLS) {
      expect(await callTool(pool, f, tool, args({ po_id: crypto.randomUUID() }))).toMatchObject({ isError: true, text: 'Not found' });
    }
  });
});

/**
 * Row security already hides another company's PO from app_user, so the tests above cannot tell whether the queries are scoped
 * themselves. Here the SERVICES run as the superuser (row security bypassed) asking company f for company `other`'s PO: only the
 * company_id in each query can answer "not found".
 */
describe('the queries are company-scoped on their own (row security bypassed)', () => {
  async function asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await als.run({ client, companyId: f.co, userId: f.owner, claims: { sub: f.owner } } as never, fn);
    } finally { await client.query('ROLLBACK'); client.release(); }
  }

  it('resolve, lock, update, cancel, close, set status and the receipt / link guards never see the other company\'s PO', async () => {
    // Their PO has a receipt and a bill linked: asked as company f, the guards must still answer "none" (their rows are not f's).
    const theirs = await seedQtyPo(pool, other, { external: true, lines: [{ qty: 4, price: 25, received: 1 }] });
    await seedGrn(pool, other, theirs);
    const bill = await seedBill(pool, other, { lines: [100] });
    expect((await callTool(pool, other, link, { links: [{ po_id: theirs.po, bill_id: bill.id }] })).isError).toBe(false);
    const auditBefore = await auditOf(pool, other, theirs.po);
    const miss = { name: 'PurchaseOrderNotFoundError' };
    await asSuperuser(async () => {
      expect(await resolvePoId(f.co, { poId: theirs.po, poNumber: null })).toBeNull();
      expect(await resolvePoId(f.co, { poId: null, poNumber: theirs.number })).toBeNull();
      expect(await lockPoForMaintenance(f.co, theirs.po)).toBeNull();
      expect(await poHasReceipts(f.co, theirs.po)).toBe(false);
      expect(await poBillTie(f.co, theirs.po)).toBeNull();
      expect(await poHasReceipts(other.co, theirs.po)).toBe(true);
      expect(await poBillTie(other.co, theirs.po)).toBe('linked');
      const o = { userId: f.owner, via: 'test', budgetFigures: false };
      await expect(updatePurchaseOrder(f.co, { poId: theirs.po, header: { notes: 'x' }, replace: null }, o)).rejects.toMatchObject(miss);
      await expect(cancelPurchaseOrder(f.co, theirs.po, 'x', o)).rejects.toMatchObject(miss);
      await expect(closePurchaseOrder(f.co, theirs.po, 'x', o)).rejects.toMatchObject(miss);
      await expect(setImportedPurchaseOrderStatus(f.co, theirs.po, 'closed', 'x', o)).rejects.toMatchObject(miss);
    });
    expect((await poRow(pool, theirs.po)).status).toBe('approved');
    expect(await auditOf(pool, other, theirs.po)).toEqual(auditBefore);
  });
});

describe('dry run of every tool', () => {
  it.each(TOOLS)('%s: PO, lines, audit and ledger unchanged; the call is write-free so the key stays free', async (_name, tool, args) => {
    const mine = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 4, price: 25 }] });
    const before = { po: await poRow(pool, mine.po), lines: await poLines(pool, mine.po), audit: await auditOf(pool, f, mine.po), gl: await glCount(pool, f) };
    const r = await callTool(pool, f, tool, { ...args({ po_id: mine.po }), dry_run: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ dry_run: true });
    expect(r.wroteNothing).toBe(true);
    expect({ po: await poRow(pool, mine.po), lines: await poLines(pool, mine.po), audit: await auditOf(pool, f, mine.po), gl: await glCount(pool, f) }).toEqual(before);
  });

  it.each(TOOLS)('%s: live success writes no ledger row and is not write-free', async (_name, tool, args) => {
    const mine = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 4, price: 25 }] });
    const gl = await glCount(pool, f);
    const r = await callTool(pool, f, tool, args({ po_id: mine.po }));
    expect(r.isError, r.text).toBe(false);
    expect(r.wroteNothing).toBe(false);
    expect(await glCount(pool, f)).toEqual(gl);
    expect((await auditOf(pool, f, mine.po)).length).toBe(1);
  });
});
