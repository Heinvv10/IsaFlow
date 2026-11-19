/**
 * set_purchase_order_status (docs/design/mcp-po-maintenance.md, decision 4), real PostgreSQL, as app_user (poImportHarness).
 * Budget: BB-6100 opex at CC1 FT, 1 000 a month; no bills here except the link cases.
 *   - only an IMPORTED PO (external_ref), only owner / admin (refused before any read), a reason, a different status;
 *   - transitions: approved -> closed (closed_from_status kept, commitment released), closed -> approved (budget check, stamped,
 *     record cleared), approved -> cancelled, cancelled -> draft, draft -> approved; every one audited old -> new with the reason;
 *   - refused: a goods receipt, a received status either side, -> draft / -> cancelled while bills are linked (approved <-> closed
 *     stay open with links);
 *   - -> approved runs the budget check normally: block refuses with nothing changed and a refused event, warn goes ahead;
 *   - dry runs write nothing; no ledger row is written.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner } from './helpers/poImportHarness';
import { seedBill } from './helpers/poBillLinkHarness';
import { auditOf, budgetEvents, callTool, dropMaintExtras, glCount, poRow, seedGrn, seedQtyPo } from './helpers/poMaintHarness';
import { setPurchaseOrderStatusTool as setStatus } from '@/lib/mcp/tools/writeSetPurchaseOrderStatus';
import { linkBillsToPurchaseOrderTool as link } from '@/lib/mcp/tools/writeLinkBillsToPurchaseOrder';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const MANAGER = { user: '', companyRole: 'manager' };

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-maint-status');
  MANAGER.user = f.manager;
  await setPolicy(pool, f, 'warn');
}, 60_000);
afterEach(async () => {
  await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE company_id = $1 AND status IN ('approved', 'partially_received', 'received')", [f.co]);
});
afterAll(async () => {
  try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const committed = async () => (await asOwner(pool, f, () => readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {}))).map((c) => c.lineTotal);
const set = (po: { po: string }, status: string, extra: Record<string, unknown> = {}, over = {}) =>
  callTool(pool, f, setStatus, { po_id: po.po, status, reason: 'Sage moved it', ...extra }, over);

describe('transitions of an imported PO', () => {
  it('approved -> closed keeps where it came from and releases the commitment; closed -> approved re-checks, stamps and clears it', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 300 }] });
    const gl = await glCount(pool, f);
    expect(await committed()).toEqual([300]);
    const closed = await set(po, 'closed');
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.body).toMatchObject({ status_set: true, status_before: 'approved', status: 'closed', closed_from_status: 'approved' });
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', closed_from_status: 'approved' });
    expect(await committed()).toEqual([]);

    await pool.query('UPDATE purchase_orders SET approved_by = NULL WHERE id = $1', [po.po]);
    const back = await set(po, 'approved');
    expect(back.isError, back.text).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'approved', closed_from_status: null, approved_by: f.owner });
    expect(await committed()).toEqual([300]);
    expect((await budgetEvents(pool, po.po)).map((e) => e.outcome)).toEqual(['pass']);

    const audit = await auditOf(pool, f, po.po);
    expect(audit.map((a) => [a.changes.fields[0]!.old, a.changes.fields[0]!.new])).toEqual([['approved', 'closed'], ['closed', 'approved']]);
    expect(audit[0]!.changes.metadata).toMatchObject({ reason: 'Sage moved it', source: 'mcp:set_purchase_order_status', status_before: 'approved' });
    expect(audit[1]!.action).toBe('approve');
    expect(await glCount(pool, f)).toEqual(gl);
  });

  it('cancelled -> draft -> approved, and approved -> cancelled; draft clears who approved it', async () => {
    const po = await seedQtyPo(pool, f, { external: true, status: 'cancelled', lines: [{ qty: 1, price: 100 }] });
    await pool.query("UPDATE purchase_orders SET approved_by = 'someone' WHERE id = $1", [po.po]);
    expect((await set(po, 'draft')).isError).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'draft', approved_by: null });
    expect((await set(po, 'approved')).isError).toBe(false);
    expect((await set(po, 'cancelled')).isError).toBe(false);
    expect((await poRow(pool, po.po)).status).toBe('cancelled');
    expect(await committed()).toEqual([]);
  });

  it('a closed PO that was closed from draft records draft, and leaving closed to cancelled clears the record', async () => {
    const po = await seedQtyPo(pool, f, { external: true, status: 'draft', lines: [{ qty: 1, price: 100 }] });
    expect((await set(po, 'closed')).body).toMatchObject({ closed_from_status: 'draft' });
    expect((await poRow(pool, po.po)).closed_from_status).toBe('draft');
    expect((await set(po, 'cancelled')).isError).toBe(false);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'cancelled', closed_from_status: null });
  });
});

describe('what refuses it', () => {
  it('a PO with no external_ref, the same status, an invalid status, no reason', async () => {
    const own = await seedQtyPo(pool, f, { lines: [{ qty: 1, price: 100 }] });
    expect((await set(own, 'closed')).text).toContain('imported from another system');
    const imp = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    expect((await set(imp, 'approved')).text).toContain('already approved');
    expect((await set(imp, 'received')).text).toContain('status must be one of draft, approved, closed, cancelled');
    expect((await set(imp, 'closed', { reason: ' ' })).text).toContain('reason is required');
    expect((await poRow(pool, imp.po)).status).toBe('approved');
  });

  it('a manager is refused before anything is read, a dry run too', async () => {
    const imp = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    for (const extra of [{}, { dry_run: true }]) {
      const r = await set(imp, 'closed', extra, MANAGER);
      expect(r).toMatchObject({ isError: true });
      expect(r.text).toContain('only an owner or admin may do');
    }
    expect((await callTool(pool, f, setStatus, { po_id: crypto.randomUUID(), status: 'closed', reason: 'x' }, MANAGER)).text).toContain('only an owner or admin');
    expect((await poRow(pool, imp.po)).status).toBe('approved');
  });

  it('a goods receipt, and a received / partially_received status either side', async () => {
    const withGrn = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 10, price: 10, received: 2 }] });
    await seedGrn(pool, f, withGrn);
    expect((await set(withGrn, 'closed')).text).toContain('a receipt is on record');
    const part = await seedQtyPo(pool, f, { external: true, status: 'partially_received', lines: [{ qty: 10, price: 10, received: 2 }] });
    expect((await set(part, 'closed')).text).toContain('comes from its goods receipts');
    expect((await poRow(pool, withGrn.po)).status).toBe('approved');
    expect((await poRow(pool, part.po)).status).toBe('partially_received');
  });

  it('with bills linked: -> draft and -> cancelled are refused; approved <-> closed are not', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    const bill = await seedBill(pool, f, { lines: [100] });
    expect((await callTool(pool, f, link, { links: [{ po_id: po.po, bill_id: bill.id }] })).isError).toBe(false);
    for (const target of ['draft', 'cancelled']) {
      const r = await set(po, target);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`cannot go to ${target}`);
      expect(r.text).toContain('unlink_bill_from_purchase_order');
    }
    expect((await poRow(pool, po.po)).status).toBe('approved');
    expect((await set(po, 'closed')).isError).toBe(false);
    expect((await set(po, 'approved')).isError).toBe(false);
    expect((await poRow(pool, po.po)).status).toBe('approved');
    const rows = await pool.query('SELECT count(*)::INT AS n FROM purchase_order_bill_links WHERE purchase_order_id = $1', [po.po]);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('-> approved and the budget', () => {
  it('under block an over-budget PO is not approved: nothing changes and a refused event is kept; under warn it goes ahead with warnings', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedQtyPo(pool, f, { external: true, status: 'closed', lines: [{ qty: 1, price: 1500 }] });
    const r = await set(po, 'approved');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^budget_exceeded: Over budget/);
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'closed', approved_by: null });
    expect((await budgetEvents(pool, po.po)).map((e) => e.outcome)).toEqual(['refused']);
    expect(await auditOf(pool, f, po.po).then((a) => a.filter((x) => x.action === 'approve'))).toHaveLength(0);

    await setPolicy(pool, f, 'warn');
    const warn = await set(po, 'approved');
    expect(warn.isError, warn.text).toBe(false);
    expect((warn.body.budget_warnings as string[]).length).toBeGreaterThan(0);
    expect((await poRow(pool, po.po)).status).toBe('approved');
  });
});

describe('dry_run', () => {
  it('reports the transition, runs the budget check, and writes nothing', async () => {
    const po = await seedQtyPo(pool, f, { external: true, lines: [{ qty: 1, price: 100 }] });
    const audit = await auditOf(pool, f, po.po);
    const dry = await set(po, 'closed', { dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, would_set: true, status_before: 'approved', status: 'closed', closed_from_status: 'approved' });
    expect(dry).toMatchObject({ wroteNothing: true });
    expect(await poRow(pool, po.po)).toMatchObject({ status: 'approved', closed_from_status: null });
    expect(await auditOf(pool, f, po.po)).toEqual(audit);
    await setPolicy(pool, f, 'block');
    const closed = await seedQtyPo(pool, f, { external: true, status: 'closed', lines: [{ qty: 1, price: 2000 }] });
    expect((await set(closed, 'approved', { dry_run: true })).text).toMatch(/^budget_exceeded:/);
    expect(await budgetEvents(pool, closed.po)).toHaveLength(0);
    await setPolicy(pool, f, 'warn');
  });
});
