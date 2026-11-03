/**
 * Budgets P5-2, the breaker's round-2 repros for PR #1103 and the hypotheses that came with them, kept as
 * regressions (real PostgreSQL as app_user):
 *   REPRO 4: a refused override attempt (with its reason) is a different act from the refusal before it,
 *            so the 60 s refused-event dedupe must keep it;
 *   REPRO 5: an MCP bulk call that posted nothing frees its idempotency key (as the single tool does), so the
 *            same call posts once the budget allows it; the refused events stay committed;
 *   (a) the preview dates a provisional's reclass by the live claim's rule (the provisional's month when the
 *       bill's VAT period is filed), so preview and approval agree;
 *   (b) the bulk dry run counts a legacy draft that already carries a journal (approved without a check)
 *       as billed against its PO line for the later bills, as the live run does;
 *   (c) two bills from one bank-first slip in one bulk batch: the second's claim refusal is a skip, not an
 *       unwind of the first; the dry run predicts that skip (round 4), and a retry posts nothing more;
 *   an identical override attempt retried is deduped (round 4).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { McpRegistry } from '@/lib/mcp/registry';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { previewBillBudget } from '@/modules/accounting/services/ap/supplierInvoiceBudgetCheck';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, eventsFor, fileVatPeriod, fromSlip, linkBillToPo, makeBill, openRequest,
  seedBillFixture, seedPo, seedProvisional, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'breaker-r2'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

async function committed<T>(fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, f, f.owner);
  try {
    const out = await r.run(fn);
    await r.commit();
    return out;
  } finally {
    await r.rollback();
  }
}
const ctx = (): McpToolContext => ({ companyId: f.co, userId: f.owner, companyRole: 'owner', scopes: ['write:invoices', 'write:post', 'read:reports'], tokenJti: 'jti-brk2', oauthAppId: null });
const text = (res: { content: Array<{ text: string }> }) => res.content[0]!.text;
const ACTION = '/api/accounting/supplier-invoices-action';
const ordered = (): [string, string] => [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];

describe('REPRO 4: the refused-event dedupe keeps a refused override attempt', () => {
  it('a manager who is refused, then tries to override with a reason, leaves a record of the override attempt', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 1500, cc1: f.cc.FT }], { date: '2026-05-15' });
    const first = await callRoute(actionRoute as never, f, f.manager, ACTION, { action: 'approve', invoiceId: bill });
    const second = await callRoute(actionRoute as never, f, f.manager, ACTION,
      { action: 'approve', invoiceId: bill, budgetOverride: true, budgetReason: 'urgent, CEO said so' });
    expect([first.statusCode, second.statusCode]).toEqual([409, 409]);
    expect(second.body.error?.message).toMatch(/only an owner or admin can override/);
    const events = await eventsFor(pool, bill);
    expect(events.map((e) => e.reason)).toEqual([null, 'urgent, CEO said so']);
    expect(events[1]!.lines.every((l) => l.overrideRequested === true)).toBe(true);
    // The same override attempt again, at once: deduped.
    await callRoute(actionRoute as never, f, f.manager, ACTION, { action: 'approve', invoiceId: bill, budgetOverride: true, budgetReason: 'urgent, CEO said so' });
    expect(await eventsFor(pool, bill)).toHaveLength(2);
  });
});

describe('REPRO 5: an MCP bulk call that posted nothing frees its key', () => {
  it('after the budget is no longer exceeded, the same call (same key) posts; the refusal stays on record', async () => {
    const registry = new McpRegistry();
    registry.register(bulkApproveSupplierInvoicesTool);
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 1500, cc1: f.cc.FT }], { date: '2026-06-15' });
    const args = { invoice_ids: [bill], idempotency_key: `k-${bill}` };
    const first = JSON.parse(text(await committed(() => registry.call('bulk_approve_supplier_invoices', args, ctx()))));
    expect(first.posted).toBe(0);
    expect(first.skipped[0].reason).toMatch(/^budget_exceeded/);
    await setPolicy(pool, f, 'warn');
    const again = JSON.parse(text(await committed(() => registry.call('bulk_approve_supplier_invoices', args, ctx()))));
    expect({ posted: again.posted, status: (await billState(pool, bill)).status }).toEqual({ posted: 1, status: 'approved' });
    expect((await eventsFor(pool, bill)).map((e) => e.outcome)).toEqual(['refused', 'warn']);
  });
});

describe('(a) the preview dates a provisional\'s reclass as the live claim does', () => {
  it('bill in a filed VAT period, provisional in an open one: the reclass lands in the provisional\'s month; preview and approval agree', async () => {
    await setPolicy(pool, f, 'block');
    const doc = await seedProvisional(pool, f, '2026-03-10');
    await fileVatPeriod(pool, f, '2026-04-01', '2026-04-30');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 1200, cc1: f.cc.FT }], { date: '2026-04-10' });
    await fromSlip(pool, bill, doc);
    const preview = await committed(() => previewBillBudget(f.co, bill));
    expect(preview!.lines.find((l) => l.month === '2026-03')?.amount).toBe(-800);
    expect(preview!.lines.find((l) => l.month === '2026-04')).toMatchObject({ amount: 1200, over: true });
    const live = await committed(() => approveSupplierInvoice(f.co, bill, f.owner, {
      budget: { channel: 'ui', lock: 'take', reason: null, override: false, actorRole: 'manager' },
    })).then(() => null, (e: unknown) => e);
    expect(live).toBeInstanceOf(BudgetExceededError);
    expect((live as BudgetExceededError).message).toContain('2026-04');
  });
});

describe('(b) the bulk dry run counts a journal-carrying draft as billed against its PO line', () => {
  it('a legacy draft with a journal, linked to a travel PO line, then a travel bill: dry run and live both post both', async () => {
    await setPolicy(pool, f, 'block');
    const [poItem] = await seedPo(pool, f, '2026-09', [{ acct: f.acc.travel, amount: 500 }]);
    const [legacy, later] = ordered();
    await makeBill(pool, f, [{ acct: f.acc.opex, amount: 100, cc1: f.cc.FT }], { date: '2026-09-15', id: legacy });
    await linkBillToPo(pool, legacy, poItem!);
    const je = crypto.randomUUID();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source)
                     VALUES ($1, $2, $3, '2026-09-15', 'posted', $4, 'legacy', 'auto_supplier_invoice')`, [je, f.co, `LEG-${je.slice(0, 6)}`, f.owner]);
      await c.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [legacy, je]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await makeBill(pool, f, [{ acct: f.acc.travel, amount: 100 }], { date: '2026-09-15', id: later });
    const dry = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [legacy, later], dry_run: true, idempotency_key: `d-${legacy}` }, ctx()))));
    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [legacy, later], idempotency_key: `l-${legacy}` }, ctx()))));
    const liveIds = (live.invoices ?? []).map((r: { id: string }) => r.id).sort();
    expect(liveIds).toEqual([legacy, later].sort());
    expect([...dry.would_post_ids].sort()).toEqual(liveIds);
  });
});

describe('(c) two bills from one bank-first slip in one bulk batch', () => {
  it('the first settles the provisional; the second\'s claim refusal is a skip, and the first stays posted', async () => {
    await setPolicy(pool, f, 'off');
    const doc = await seedProvisional(pool, f, '2026-11-10');
    // The slip's read VAT, so an agent may post bills raised from it (K-072).
    await pool.query(`UPDATE captured_documents SET extracted_data = '{"vatAmount": 120}'::JSONB WHERE id = $1`, [doc]);
    const [a, b] = ordered();
    for (const id of [a, b]) {
      await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }], { date: '2026-11-10', id });
      await fromSlip(pool, id, doc);
    }
    const res = await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [a, b], idempotency_key: `c-${a}` }, ctx()));
    expect(res.isError, text(res)).toBeFalsy();
    const out = JSON.parse(text(res));
    expect(out.posted).toBe(1);
    expect(out.skipped).toEqual([expect.objectContaining({ document_id: b, reason: expect.stringMatching(/^payment_refused: /) })]);
    expect((await billState(pool, a)).status).not.toBe('draft');
    expect((await billState(pool, b)).status).toBe('draft');
  });
});

describe('(c, round 4) two bills from one slip: the dry run predicts the live skip; retries post nothing more', () => {
  it('dry run would post [a] only; live posts a and skips b; one settlement, one reclass, one bill journal', async () => {
    await setPolicy(pool, f, 'block');
    const doc = await seedProvisional(pool, f, '2026-12-10');
    await pool.query(`UPDATE captured_documents SET extracted_data = '{"vatAmount": 120}'::JSONB WHERE id = $1`, [doc]);
    const [a, b] = ordered();
    for (const id of [a, b]) {
      await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }], { date: '2026-12-10', id });
      await fromSlip(pool, id, doc);
    }
    const reg = new McpRegistry();
    reg.register(bulkApproveSupplierInvoicesTool);
    const call = (args: Record<string, unknown>) => committed(() => reg.call('bulk_approve_supplier_invoices', args, ctx())).then((r) => JSON.parse(text(r)));
    const dry = await call({ invoice_ids: [a, b], dry_run: true, idempotency_key: `d-${a}` });
    expect(dry.would_post_ids).toEqual([a]);
    expect(dry.skipped).toEqual([expect.objectContaining({ document_id: b, reason: expect.stringMatching(/^payment_refused: /) })]);
    const args = { invoice_ids: [a, b], idempotency_key: `l-${a}` };
    const live = await call(args);
    expect(live.invoices.map((r: { id: string }) => r.id)).toEqual([a]);
    expect((await call(args)).posted).toBe(1); // the stored success replayed, not a second post
    expect((await call({ invoice_ids: [b], idempotency_key: `b-${b}` })).posted).toBe(0);
    // This month only: (c) above settled another slip in 2026-11.
    const counts = (await pool.query(
      `SELECT (SELECT count(*)::INT FROM supplier_payments WHERE company_id = $1 AND settles_provisional_je_id IS NOT NULL AND payment_date = '2026-12-10') AS settlements,
              (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1 AND description LIKE 'Provisional % becomes payment%' AND entry_date = '2026-12-10') AS reclasses,
              (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1 AND source = 'auto_supplier_invoice' AND entry_date = '2026-12-10') AS bill_journals`,
      [f.co])).rows[0];
    expect(counts).toEqual({ settlements: 1, reclasses: 1, bill_journals: 1 });
    expect((await billState(pool, b))).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
  });
});

describe('(round 4) an identical override attempt retried is deduped', () => {
  it('three identical refused override attempts: one event', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 1500, cc1: f.cc.FT }], { date: '2026-08-15' });
    const body = { action: 'approve', invoiceId: bill, budgetOverride: true, budgetReason: 'x' };
    for (let i = 0; i < 3; i += 1) expect((await callRoute(actionRoute as never, f, f.manager, ACTION, body)).statusCode).toBe(409);
    expect(await eventsFor(pool, bill)).toHaveLength(1);
  });
});
