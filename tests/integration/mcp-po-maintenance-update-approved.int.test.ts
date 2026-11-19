/**
 * update_purchase_order on an APPROVED PO and the dry run (docs/design/mcp-po-maintenance.md, decision 1), real PostgreSQL, as app_user.
 * Budget: BB-6100 opex at CC1 FT, 1 000 a month (budgetBillFixture), PO dated 2026-06.
 *   - an edit that raises the commitment is judged by the Approve action's check on the NEW lines: block refuses (nothing changes,
 *     a refused event is recorded), warn goes ahead with budget_warnings, within budget passes; commitments follow the new lines;
 *   - a draft's edit is not checked; a header edit that moves neither lines nor month is not checked;
 *   - dry_run runs the same guards in a rolled-back savepoint: same refusal, same figures, nothing written, key left free.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { asOwner } from './helpers/poImportHarness';
import { seedPo } from './helpers/poBillLinkHarness';
import { auditOf, budgetEvents, callTool, dropMaintExtras, glCount, poLines, poRow } from './helpers/poMaintHarness';
import { updatePurchaseOrderTool as update } from '@/lib/mcp/tools/writeUpdatePurchaseOrder';
import { updatePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderUpdate';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-maint-approved'); }, 60_000);
afterEach(async () => {
  // Open POs commit spend: cancel what a test left so the next one starts from an empty slice.
  await pool.query("UPDATE purchase_orders SET status = 'cancelled' WHERE company_id = $1 AND status IN ('approved', 'draft')", [f.co]);
});
afterAll(async () => {
  try { await dropMaintExtras(pool, f); await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const lines = (price: number) => [{ description: 'Cable', quantity: 1, unit_price: price, tax_rate: 0, gl_account_id: f.acc.opex, cc1: f.cc.FT }];
const committed = async () => (await asOwner(pool, f, () => readCommitments(f.co, [f.acc.opex], '2026-06-01', '2026-06-30', {}))).map((c) => c.lineTotal);

describe('an approved PO', () => {
  it('under block, an edit past the remaining budget is refused whole: lines, totals and commitment unchanged, a refused event kept', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [600], acct: f.acc.opex, cc1: f.cc.FT });
    const r = await callTool(pool, f, update, { po_id: po.po, notes: 'bigger', lines: lines(1200) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^budget_exceeded: Over budget/);
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['600.00']);
    expect(await poRow(pool, po.po)).toMatchObject({ subtotal: '600.00', notes: null });
    expect(await committed()).toEqual([600]);
    expect((await budgetEvents(pool, po.po)).map((e) => e.outcome)).toEqual(['refused']);
    expect(await auditOf(pool, f, po.po).then((a) => a.filter((x) => x.action === 'update'))).toHaveLength(0);
  });

  it('under block, an edit within the budget passes and the commitment follows the new lines (the old ones are not counted twice)', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [600], acct: f.acc.opex, cc1: f.cc.FT });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: lines(950) });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ updated: true, status: 'approved', budget_checked: true, budget_warnings: [] });
    expect(await committed()).toEqual([950]);
    expect((await budgetEvents(pool, po.po)).map((e) => e.outcome)).toEqual(['pass']);
    expect((await auditOf(pool, f, po.po)).at(-1)!.changes.metadata).toMatchObject({ budgetChecked: 'true' });
  });

  it('under warn, the same over-budget edit goes ahead and says so', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [600], acct: f.acc.opex, cc1: f.cc.FT });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: lines(1200) });
    expect(r.isError, r.text).toBe(false);
    expect(String(r.body.budget_warning)).toContain('Over budget');
    expect((r.body.budget_warnings as string[]).length).toBeGreaterThan(0);
    expect(await committed()).toEqual([1200]);
    expect((await budgetEvents(pool, po.po)).map((e) => e.outcome)).toEqual(['warn']);
  });

  it('a notes edit (lines and month unchanged) is not re-checked, so an already over-budget PO can still be annotated under block', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [1500], acct: f.acc.opex, cc1: f.cc.FT });
    await setPolicy(pool, f, 'block');
    const r = await callTool(pool, f, update, { po_id: po.po, notes: 'annotated' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ budget_checked: false });
    expect(await budgetEvents(pool, po.po)).toHaveLength(0);
    // Moving the order date re-checks (the month can change what the PO is judged against), and block refuses it.
    const moved = await callTool(pool, f, update, { po_id: po.po, order_date: '2026-07-03' });
    expect(moved.text).toMatch(/^budget_exceeded:/);
    expect((await poRow(pool, po.po)).order_date).toBe('2026-06-02');
  });

  it('a draft is not budget-checked: a huge edit under block succeeds and records no event', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { status: 'draft', lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: lines(99000) });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ budget_checked: false });
    expect(await budgetEvents(pool, po.po)).toHaveLength(0);
    expect(await committed()).toEqual([]);
  });
});

describe('who may edit an approved PO, and what the edit does to the approval (review M2)', () => {
  const MANAGER = { user: '', companyRole: 'manager' };
  beforeAll(() => { MANAGER.user = f.manager; });

  it('an owner / admin only: a manager is refused for an approved PO before the edit is read (bad item code, dry run), but may edit a draft and a submitted one', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    const bad = [{ description: 'x', quantity: 1, unit_price: 1, item_code: 'NO-SUCH-ITEM' }];
    for (const extra of [{}, { dry_run: true }, { lines: bad }, { supplier_id: crypto.randomUUID() }]) {
      const r = await callTool(pool, f, update, { po_id: po.po, notes: 'x', ...extra }, MANAGER);
      expect(r.isError).toBe(true);
      expect(r.text).toBe('Editing an approved purchase order changes what it commits, which only an owner or admin may do.');
    }
    expect(await poRow(pool, po.po)).toMatchObject({ notes: null });
    expect(await auditOf(pool, f, po.po)).toHaveLength(0);
    for (const status of ['draft', 'submitted']) {
      const other = await seedPo(pool, f, { status, lines: [100] });
      expect((await callTool(pool, f, update, { po_id: other.po, notes: 'ok' }, MANAGER)).isError, status).toBe(false);
    }
    expect((await callTool(pool, f, update, { po_id: po.po, notes: 'by admin' }, { companyRole: 'admin' })).isError).toBe(false);
  });

  it('the service itself refuses an approved PO for a caller not marked owner / admin (the tool is not the only door)', async () => {
    const po = await seedPo(pool, f, { lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    await expect(asOwner(pool, f, () => updatePurchaseOrder(f.co, { poId: po.po, header: { notes: 'x' }, replace: null }, { userId: f.manager, via: 'test', budgetFigures: false })))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_MAINTENANCE_REFUSED' });
    expect((await poRow(pool, po.po)).notes).toBeNull();
  });

  it('the approval is restamped to the editing owner / admin and the original is kept in the audit row; a draft keeps its (absent) approval', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    await pool.query("UPDATE purchase_orders SET approved_by = $2, approved_at = '2026-06-01 10:00:00+00' WHERE id = $1", [po.po, f.manager]);
    const r = await callTool(pool, f, update, { po_id: po.po, lines: lines(120) });
    expect(r.isError, r.text).toBe(false);
    const row = (await pool.query('SELECT approved_by, approved_at > now() - interval \'1 minute\' AS fresh FROM purchase_orders WHERE id = $1', [po.po])).rows[0];
    expect(row).toEqual({ approved_by: f.owner, fresh: true });
    const meta = (await auditOf(pool, f, po.po)).at(-1)!.changes.metadata!;
    expect(meta.prior_approved_by).toBe(f.manager);
    expect(meta.prior_approved_at).toContain('2026-06-01');
    const draft = await seedPo(pool, f, { status: 'draft', lines: [100] });
    await callTool(pool, f, update, { po_id: draft.po, notes: 'd' });
    expect((await poRow(pool, draft.po)).approved_by).toBeNull();
  });

  it('under block every line of an approved PO needs an account (a line with none would escape the check); warn and a draft allow it', async () => {
    const noAccount = [{ description: 'No account', quantity: 1, unit_price: 5000, tax_rate: 0 }];
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [100], acct: f.acc.opex, cc1: f.cc.FT });
    const r = await callTool(pool, f, update, { po_id: po.po, lines: noAccount });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('needs an expense account');
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['100.00']);
    const draft = await seedPo(pool, f, { status: 'draft', lines: [100] });
    expect((await callTool(pool, f, update, { po_id: draft.po, lines: noAccount })).isError).toBe(false);
    await setPolicy(pool, f, 'warn');
    expect((await callTool(pool, f, update, { po_id: po.po, lines: noAccount })).isError).toBe(false);
  });

  it('a month move is judged in the NEW month: the budget slice of the month it leaves only loses commitment', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [900], acct: f.acc.opex, cc1: f.cc.FT });
    await seedPo(pool, f, { lines: [800], acct: f.acc.opex, cc1: f.cc.FT, date: '2026-07' });
    const moved = await callTool(pool, f, update, { po_id: po.po, order_date: '2026-07-03' });
    expect(moved.text).toMatch(/^budget_exceeded:/); // 800 already committed in July + 900 > 1 000
    expect((await poRow(pool, po.po)).order_date).toBe('2026-06-02');
    await setPolicy(pool, f, 'warn');
  });
});

describe('dry_run', () => {
  it('reports the figures and the warnings the live edit would, writes nothing and leaves the key free', async () => {
    await setPolicy(pool, f, 'warn');
    const po = await seedPo(pool, f, { lines: [600], acct: f.acc.opex, cc1: f.cc.FT });
    const before = { gl: await glCount(pool, f), audit: await auditOf(pool, f, po.po), events: await budgetEvents(pool, po.po) };
    const dry = await callTool(pool, f, update, { po_id: po.po, lines: lines(1200), notes: 'dry', dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, would_update: true, total: 1200, status: 'approved' });
    expect((dry.body.budget_warnings as string[]).length).toBeGreaterThan(0);
    expect(dry).toMatchObject({ wroteNothing: true });
    expect((await poLines(pool, po.po)).map((l) => l.line_total)).toEqual(['600.00']);
    expect((await poRow(pool, po.po)).notes).toBeNull();
    expect({ gl: await glCount(pool, f), audit: await auditOf(pool, f, po.po), events: await budgetEvents(pool, po.po) }).toEqual(before);
    expect(await committed()).toEqual([600]);
  });

  it('refuses what the live call refuses: a block under block policy, a receipt, a bad total; no refused event is recorded', async () => {
    await setPolicy(pool, f, 'block');
    const po = await seedPo(pool, f, { lines: [600], acct: f.acc.opex, cc1: f.cc.FT });
    const dry = await callTool(pool, f, update, { po_id: po.po, lines: lines(1200), dry_run: true });
    expect(dry.isError).toBe(true);
    expect(dry.text).toMatch(/^budget_exceeded: Over budget/);
    expect(await budgetEvents(pool, po.po)).toHaveLength(0);
    const live = await callTool(pool, f, update, { po_id: po.po, lines: lines(1200) });
    expect(live.text).toBe(dry.text);
    const total = await callTool(pool, f, update, { po_id: po.po, lines: lines(10), expected_totals: { total: 9 }, dry_run: true });
    expect(total.text).toContain('expected_totals.total is 9.00 but the lines add up to 10.00');
  });
});
