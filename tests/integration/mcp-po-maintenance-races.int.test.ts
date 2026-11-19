/**
 * The maintenance tools' lock order in motion (docs/design/mcp-po-maintenance.md, the census; #1627's extended), real PostgreSQL,
 * as app_user, under the BLOCK policy (the budget gate is taken): update x close x cancel x set status x link x unlink x PO approve
 * on the same rows, ten rounds. No deadlock (40P01), no lock timeout (55P03 / the typed ones), no thrown error: every loser is a
 * clean refusal. The end state is consistent (closed iff a closed_from_status, header totals equal the lines).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedBill } from './helpers/poBillLinkHarness';
import { callTool, dropMaintExtras, poLines, poRow, seedQtyPo } from './helpers/poMaintHarness';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { cancelPurchaseOrderTool as cancel } from '@/lib/mcp/tools/writeCancelPurchaseOrder';
import { closePurchaseOrderTool as close } from '@/lib/mcp/tools/writeClosePurchaseOrder';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { unlinkBillFromPurchaseOrderTool as unlink } from '@/lib/mcp/tools/writeUnlinkBillFromPurchaseOrder';
import { approvePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderApprove';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-races'); }, 60_000);
afterAll(async () => {
  try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await setPolicy(pool, f, 'warn').catch(() => undefined); await pool.end(); }
}, 60_000);

const line = (price: number) => ({ description: 'Raced', quantity: 1, unit_price: price, tax_rate: 0, gl_account_id: f.acc.nob });

describe('races', () => {
  it('update x close x cancel x set status x link x unlink x approve on the same rows under block: no deadlock, no timeout, a consistent end state', async () => {
    await setPolicy(pool, f, 'block');
    const unexpected: string[] = [];
    for (let i = 0; i < 10; i++) {
      const p1 = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }], acct: f.acc.nob });
      const p2 = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }], acct: f.acc.nob });
      const p3 = await seedQtyPo(pool, f, { external: true, status: 'closed', lines: [{ qty: 1, price: 100 }], acct: f.acc.nob });
      const p4 = await seedQtyPo(pool, f, { status: 'draft', lines: [{ qty: 1, price: 100 }], acct: f.acc.nob });
      const toLink = await seedBill(pool, f, { lines: [100] });
      const linked = await seedBill(pool, f, { lines: [100] });
      expect((await callTool(pool, f, link, { links: [{ po_id: p2.po, bill_id: linked.id }] })).isError).toBe(false);
      const approveDraft = async () => {
        const req = await openRequest(pool, f, f.owner);
        try { await req.run(() => approvePurchaseOrder(f.co, p4.po, f.owner, { channel: 'ui', lock: 'take', reason: 'race', override: false, actorRole: 'owner' })); await req.commit(); } catch (e) { await req.rollback(); throw e; }
      };
      const ops: Array<[string, Promise<unknown>]> = [
        ['update P1', callTool(pool, f, update, { po_id: p1.po, lines: [line(150 + i)] })],
        ['close P1', callTool(pool, f, close, { po_id: p1.po, reason: 'race' })],
        ['cancel P1', callTool(pool, f, cancel, { po_id: p1.po, reason: 'race' })],
        ['set P1 cancelled', callTool(pool, f, setStatus, { po_id: p1.po, status: 'cancelled', reason: 'race' })],
        ['link P1', callTool(pool, f, link, { links: [{ po_id: p1.po, bill_id: toLink.id }] })],
        ['update P2 (linked)', callTool(pool, f, update, { po_id: p2.po, notes: 'race' })],
        ['unlink P2', callTool(pool, f, unlink, { po_id: p2.po, bill_id: linked.id, reason: 'race' })],
        ['close P2', callTool(pool, f, close, { po_id: p2.po, reason: 'race' })],
        ['set P3 approved', callTool(pool, f, setStatus, { po_id: p3.po, status: 'approved', reason: 'race' })],
        ['approve P4', approveDraft()],
        ['update P4', callTool(pool, f, update, { po_id: p4.po, lines: [line(20 + i)] })],
      ];
      const settled = await Promise.allSettled(ops.map(([, p]) => p));
      settled.forEach((r, k) => { if (r.status === 'rejected') unexpected.push(`${ops[k]![0]}: ${(r.reason as { code?: string }).code ?? ''} ${(r.reason as Error).message}`); });

      for (const p of [p1, p2, p3, p4]) {
        const row = await poRow(pool, p.po);
        expect(['draft', 'approved', 'closed', 'cancelled'], `${p.number}`).toContain(row.status);
        if (row.status === 'closed') expect(row.closed_from_status, `${p.number} closed with its record`).not.toBeNull();
        else expect(row.closed_from_status, `${p.number} not closed: no record`).toBeNull();
        const lines = await poLines(pool, p.po);
        expect(Number(row.subtotal), `${p.number} header = lines`).toBe(lines.reduce((s, l) => s + Number(l.line_total), 0));
      }
    }
    expect(unexpected).toEqual([]);
  }, 180_000);
});
