/**
 * Budgets P5-2b (Hein, 2026-11-04): off-slice lines on the other paths, real PostgreSQL as app_user:
 *   - MCP bulk approve (block): the off-slice bill is skipped `budget_exceeded`, the others post; the dry run agrees;
 *   - PO approve (block): an order with an off-slice line is refused 409, its refused event persisted, status unchanged;
 *   - preview (POST /budgets/remaining, bill and PO modes): the line comes back `offSlice: true` and counts in overCount.
 * Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0, nob BB-6300 unbudgeted (`budgetBillFixture.ts`).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, eventsFor, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { approvePo, makePo, poState } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'off-slice-paths'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`budget-remaining:${u}`, `purchase-order-approve:${u}`])]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const ctx = (): McpToolContext =>
  ({ companyId: f.co, userId: f.owner, companyRole: 'owner', scopes: ['write:invoices', 'write:post', 'read:reports'], tokenJti: 'jti-off', oauthAppId: null });
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
const preview = (body: unknown) => callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', body);

describe('MCP bulk approve, block', () => {
  it('skips the off-slice bill (budget_exceeded), posts the others; the dry run names the same skip', async () => {
    await setPolicy(pool, f, 'block');
    const fits = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 100, cc1: f.cc.FT }], { date: '2026-04-15' });
    const off = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 100 }], { date: '2026-04-15' });
    const nob = await makeBill(pool, f, [{ acct: f.acc.nob, amount: 100 }], { date: '2026-04-15' });
    const ids = [fits, off, nob];
    const dry = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: ids, dry_run: true, idempotency_key: `off-d-${off}` }, ctx()))));
    expect([...dry.would_post_ids].sort()).toEqual([fits, nob].sort());
    expect(dry.skipped).toEqual([expect.objectContaining({ document_id: off, reason: expect.stringMatching(/^budget_exceeded: .*BB-6100 Opex · no cost centre 1 · 2026-04: not in a budgeted slice/) })]);

    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: ids, idempotency_key: `off-l-${off}` }, ctx()))));
    expect(live.posted).toBe(2);
    expect(live.skipped).toEqual([expect.objectContaining({ document_id: off, reason: expect.stringMatching(/^budget_exceeded: .*not in a budgeted slice/) })]);
    expect((await billState(pool, fits)).status).toBe('approved');
    expect((await billState(pool, nob)).status).toBe('approved');
    expect((await billState(pool, off))).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    expect((await eventsFor(pool, off)).map((e) => [e.outcome, e.channel])).toEqual([['refused', 'mcp']]);
  });

  it('warn: every bill posts, the off-slice one with a warning', async () => {
    await setPolicy(pool, f, 'warn');
    const off = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 100 }], { date: '2026-05-15' });
    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [off], idempotency_key: `off-w-${off}` }, ctx()))));
    expect(live.posted).toBe(1);
    expect(JSON.stringify(live)).toContain('Not in a budgeted slice: BB-6100 Opex · no cost centre 1 · 2026-05');
    expect((await eventsFor(pool, off)).map((e) => e.outcome)).toEqual(['warn']);
  });
});

describe('PO approve, block', () => {
  it('an order with an off-slice line is refused; status unchanged; the refused event persisted', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100, cc1: f.cc.FT }, { acct: f.acc.opex, amount: 50 }]);
    const r = await approvePo(f, f.manager, po);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error?.message).toContain('BB-6100 Opex · no cost centre 1 · 2026-06: not in a budgeted slice');
    expect((await poState(pool, po)).status).toBe('draft');
    const [ev] = await eventsFor(pool, po);
    expect(ev).toMatchObject({ outcome: 'refused', channel: 'ui' });
    expect(ev!.lines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'off_slice' }), expect.objectContaining({ kind: 'within' })]));
  });

  it('an order on a budgeted slice and an unbudgeted account is approved', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100, cc1: f.cc.FT }, { acct: f.acc.nob, amount: 5000 }]);
    expect((await approvePo(f, f.manager, po)).statusCode).toBe(200);
  });
});

describe('preview', () => {
  it('bill mode: the off-slice line is labelled, flagged offSlice and counted', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 80 }, { acct: f.acc.nob, amount: 10 }], { date: '2026-07-15' });
    const r = await preview({ supplierInvoiceId: bill });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ checks: true, overCount: 1 });
    expect((r.body.data as { lines: unknown[] }).lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountLabel: 'BB-6100 Opex', unassigned: true, offSlice: true, over: false, budget: null, amount: 80 }),
      expect.objectContaining({ accountLabel: 'BB-6300 Unbudgeted', offSlice: false, budget: null }),
    ]));
    const bulk = await preview({ supplierInvoiceIds: [bill] });
    expect(bulk.body.data).toMatchObject({ overBills: 1 });
  });

  it('PO mode: the off-slice line is flagged and counted', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await makePo(pool, f, '2026-08', [{ acct: f.acc.opex, amount: 50 }]);
    const r = await preview({ purchaseOrderId: po });
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toMatchObject({ overCount: 1, lines: [expect.objectContaining({ offSlice: true, accountLabel: 'BB-6100 Opex' })] });
  });
});
