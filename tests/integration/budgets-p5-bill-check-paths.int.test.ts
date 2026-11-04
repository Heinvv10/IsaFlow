/**
 * Budgets P5-2 (spec §3b/§4, census findings 1, 4, 5): the budget check on every other approval
 * path, real PostgreSQL as app_user. MCP single and bulk (typed refusal, budget_warnings, one
 * over-budget bill never unwinds the batch), the bulk route (per-item BUDGET_EXCEEDED, the batch
 * reason), capture's auto-approval (withdrawn to draft in block mode), and a system event written
 * with no session user. Each case uses its own month of the fixture budget (opex FT 1 000 a month).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMoney as R } from '@/lib/money/formatMoney';
import { Pool } from 'pg';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { recordBudgetCheckEvent } from '@/modules/accounting/services/budgets/budgetCheck';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, eventsFor, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'paths'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

// read:reports: these tests read the figures in the messages (without it they are worded without amounts: -mcp suite).
const ctx = (): McpToolContext => ({ companyId: f.co, userId: f.owner, companyRole: 'owner', scopes: ['write:invoices', 'write:post', 'read:reports'], tokenJti: 'jti-p52', oauthAppId: null });
const bill = (month: string, amount: number, acct: 'opex' | 'travel' = 'opex') =>
  makeBill(pool, f, [{ acct: f.acc[acct], amount, cc1: acct === 'opex' ? f.cc.FT : null }], { date: `${month}-15` });
/** Runs `fn` as one committed request of the owner. */
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
const text = (res: { content: Array<{ text: string }> }) => res.content[0]!.text;

describe('MCP approve_supplier_invoice', () => {
  it('block, over budget: a typed refusal, the refused event committed, the bill still a draft', async () => {
    await setPolicy(pool, f, 'block');
    const id = await bill('2026-04', 1500);
    const res = await committed(() => approveSupplierInvoiceTool.handler({ invoice_id: id, idempotency_key: `k-${id}` }, ctx()));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^BUDGET_EXCEEDED: Over budget — approval refused: BB-6100 Opex · FT Fibertime · 2026-04/);
    expect((await billState(pool, id)).status).toBe('draft');
    expect((await eventsFor(pool, id)).map((e) => [e.outcome, e.channel])).toEqual([['refused', 'mcp']]);
  });

  it('warn, over budget: posted, budget_warnings returned, event warn with no reason', async () => {
    await setPolicy(pool, f, 'warn');
    const id = await bill('2026-05', 1500);
    const res = await committed(() => approveSupplierInvoiceTool.handler({ invoice_id: id, idempotency_key: `k-${id}` }, ctx()));
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).budget_warnings).toEqual([expect.stringContaining(`remaining ${R(1000)}, this bill ${R(1500)}`)]);
    expect(await eventsFor(pool, id)).toEqual([expect.objectContaining({ outcome: 'warn', channel: 'mcp', reason: null })]);
  });
});

describe('MCP bulk_approve_supplier_invoices', () => {
  it('block: one over-budget bill is skipped, the others post, and its refused event is committed', async () => {
    await setPolicy(pool, f, 'block');
    const fits = [await bill('2026-07', 100, 'travel'), await bill('2026-07', 200)];
    const over = await bill('2026-07', 5000);
    const res = await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [...fits, over], idempotency_key: `kb-${over}` }, ctx()));
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(text(res));
    expect(out.posted).toBe(2);
    expect(out.skipped).toEqual([expect.objectContaining({ document_id: over, reason: expect.stringMatching(/^budget_exceeded: Over budget/) })]);
    for (const id of fits) expect((await billState(pool, id)).status).toBe('approved');
    expect((await billState(pool, over)).status).toBe('draft');
    expect((await eventsFor(pool, over)).map((e) => [e.outcome, e.channel])).toEqual([['refused', 'mcp']]);
  });
});

describe('MCP bulk dry run (parity with the live skip)', () => {
  it('block: a bill over budget on its own is listed as budget_exceeded, the others would post; nothing written', async () => {
    await setPolicy(pool, f, 'block');
    const fits = await bill('2026-06', 100, 'travel');
    const over = await bill('2026-06', 5000);
    const res = await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [fits, over], dry_run: true, idempotency_key: `kd-${over}` }, ctx()));
    const out = JSON.parse(text(res));
    expect(out).toMatchObject({ dry_run: true, would_post: 1, would_post_ids: [fits] });
    expect(out.skipped).toEqual([expect.objectContaining({ document_id: over, reason: expect.stringMatching(/^budget_exceeded: Over budget — approval refused: BB-6100/) })]);
    expect((await billState(pool, over)).status).toBe('draft');
    expect(await eventsFor(pool, over)).toHaveLength(0);
  });
});

describe('MCP bulk dry run, cumulative in batch order', () => {
  /** Two FT bills of 600 against FT's 1 000: each fits alone, not together. Ids ordered so `first` posts first. */
  async function pair(month: string) {
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
    for (const id of [second, first]) await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }], { date: `${month}-15`, id });
    return { first, second };
  }
  const dryRun = (ids: string[]) => committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: ids, dry_run: true, idempotency_key: `kc-${ids[0]}` }, ctx()));

  it('block: the second bill is reported refused, as the live run under the lock refuses it', async () => {
    await setPolicy(pool, f, 'block');
    const { first, second } = await pair('2027-01');
    const out = JSON.parse(text(await dryRun([second, first])));
    expect(out).toMatchObject({ would_post: 1, would_post_ids: [first] });
    expect(out.skipped).toEqual([expect.objectContaining({ document_id: second,
      reason: expect.stringContaining(`remaining ${R(400)}, this bill ${R(600)}`) })]);
    // The live call agrees.
    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [second, first], idempotency_key: `kl-${first}` }, ctx()))));
    expect(live.posted).toBe(1);
    expect(live.skipped.map((x: { document_id: string }) => x.document_id)).toEqual([second]);
  });

  it('warn: both would post, the second reported with its budget warning', async () => {
    await setPolicy(pool, f, 'warn');
    const { first, second } = await pair('2027-02');
    const out = JSON.parse(text(await dryRun([first, second])));
    expect(out).toMatchObject({ would_post: 2, skipped: [] });
    expect(out.budget_warnings).toEqual([expect.objectContaining({ document_id: second,
      warnings: [expect.stringContaining(`remaining ${R(400)}, this bill ${R(600)}`)] })]);
  });
});

describe('the bulk route', () => {
  it('block: per-item BUDGET_EXCEEDED, the rest approved, the refused event recorded', async () => {
    await setPolicy(pool, f, 'block');
    const fits = await bill('2026-08', 300);
    const over = await bill('2026-08', 5000);
    const r = await callRoute(bulkRoute as never, f, f.manager, '/api/accounting/supplier-invoices-bulk-action',
      { action: 'approve', invoiceIds: [fits, over] });
    expect(r.statusCode).toBe(200);
    const data = r.body.data as { succeeded: number; results: Array<{ invoiceId: string; ok: boolean; reason?: string; error?: string }> };
    expect(data.succeeded).toBe(1);
    expect(data.results.find((x) => x.invoiceId === over)).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED', error: expect.stringContaining(`this bill ${R(5000)}`) });
    expect((await billState(pool, fits)).status).toBe('approved');
    expect((await billState(pool, over)).status).toBe('draft');
    expect((await eventsFor(pool, over)).map((e) => [e.outcome, e.channel, e.decided_by])).toEqual([['refused', 'bulk', f.manager]]);
  });

  it('warn: proceeds with budgetWarnings; the batch reason is recorded on the event', async () => {
    await setPolicy(pool, f, 'warn');
    const over = await bill('2026-09', 1500);
    const r = await callRoute(bulkRoute as never, f, f.manager, '/api/accounting/supplier-invoices-bulk-action',
      { action: 'approve', invoiceIds: [over], budgetReason: 'Quarter-end batch' });
    expect(r.statusCode).toBe(200);
    expect((r.body.data as { results: Array<{ budgetWarnings?: string[] }> }).results[0]!.budgetWarnings).toHaveLength(1);
    expect(await eventsFor(pool, over)).toEqual([expect.objectContaining({ outcome: 'warn', channel: 'bulk', reason: 'Quarter-end batch' })]);
  });
});

describe('capture auto-approval (postToGLInner, census finding 1)', () => {
  it('block, over budget: the posting is refused, the auto-approval withdrawn to draft, the refused event kept', async () => {
    await setPolicy(pool, f, 'block');
    const id = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 4000, cc1: f.cc.FT }], { date: '2026-10-15', status: 'approved' });
    const out = await committed(() => attachEvidenceAndSettleApproved({
      companyId: f.co, userId: f.owner, documentId: crypto.randomUUID(), invoiceId: id, invoiceStatus: 'approved',
      supplierId: f.supplier, totalAmount: 4600, invoiceDate: '2026-10-15', postUnattached: true,
    }));
    expect(out.settlementRefused).toMatch(/^Over budget — approval refused/);
    const s = await billState(pool, id);
    expect(s).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    expect(s.notes).toContain('Auto-approval withdrawn');
    expect((await eventsFor(pool, id)).map((e) => [e.outcome, e.channel])).toEqual([['refused', 'system']]);
  });

  it('warn, over budget: posted, event warn on the system channel', async () => {
    await setPolicy(pool, f, 'warn');
    const id = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 4000, cc1: f.cc.FT }], { date: '2026-11-15', status: 'approved' });
    const out = await committed(() => attachEvidenceAndSettleApproved({
      companyId: f.co, userId: f.owner, documentId: crypto.randomUUID(), invoiceId: id, invoiceStatus: 'approved',
      supplierId: f.supplier, totalAmount: 4600, invoiceDate: '2026-11-15', postUnattached: true,
    }));
    expect(out.settlementRefused).toBeUndefined();
    expect((await billState(pool, id)).gl_journal_entry_id).not.toBeNull();
    expect(await eventsFor(pool, id)).toEqual([expect.objectContaining({ outcome: 'warn', channel: 'system', reason: null })]);
  });
});

describe('a system event with no session user (954 trigger + RLS)', () => {
  it('on the service pool role with no claims, decided_by is the actor the caller names; a session user always wins', async () => {
    const id = await bill('2026-12', 10);
    const event = { companyId: f.co, documentType: 'supplier_invoice' as const, documentId: id, documentRef: 'P52', policy: 'warn' as const,
      lines: [], reason: null, channel: 'system' as const, actorId: f.owner };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_service'); // isaflow_service's role: no JWT claims, no company GUC
      await als.run({ client: c, companyId: f.co, userId: f.owner, claims: {} } as never, () => recordBudgetCheckEvent(event, 'warn'));
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const session = await openRequest(pool, f, f.manager);
    await session.run(() => recordBudgetCheckEvent({ ...event, actorId: f.owner }, 'pass'));
    await session.commit();
    expect((await eventsFor(pool, id)).map((e) => [e.outcome, e.decided_by])).toEqual([['warn', f.owner], ['pass', f.manager]]);
  });
});
