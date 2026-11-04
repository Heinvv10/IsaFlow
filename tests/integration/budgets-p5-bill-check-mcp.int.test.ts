/**
 * Budgets P5-2 review round 2, real PostgreSQL as app_user:
 *   - S1: an MCP token without read:reports gets budget refusals, warnings and dry-run verdicts
 *     naming the line (account, slice, month) and "over budget", never remaining or amounts;
 *   - a bulk call whose every bill is budget-refused frees its key (nothing posted); its refused events stay;
 *   - R2: the bulk tool holds the company budget lock BEFORE any lock on a bill's line accounts
 *     (probed: blocked on a held account row, it already holds the advisory lock);
 *   - R7: the bulk route's Post to GL under block refuses an over-budget bill per item;
 *   - round 5: the bulk route is rate-limited per user, charged per id.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, eventsFor, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'mcp-r2'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const ctx = (scopes: string[] = ['write:invoices', 'write:post']): McpToolContext =>
  ({ companyId: f.co, userId: f.owner, companyRole: 'owner', scopes, tokenJti: 'jti-r2', oauthAppId: null });
const ftBill = (month: string, amount: number, status = 'draft') =>
  makeBill(pool, f, [{ acct: f.acc.opex, amount, cc1: f.cc.FT }], { date: `${month}-15`, status });
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
/** No rand figure: neither the R symbol before a digit nor the words remaining / this bill. */
const noFigures = (s: string) => {
  expect(s).not.toMatch(/R\s?\d/u);
  expect(s).not.toMatch(/remaining|this bill/);
};

describe('S1: no budget figures without read:reports', () => {
  it('single approve, block: the refusal names the line and "over budget" only', async () => {
    await setPolicy(pool, f, 'block');
    const id = await ftBill('2026-04', 1500);
    const t = text(await committed(() => approveSupplierInvoiceTool.handler({ invoice_id: id, idempotency_key: `s1-${id}` }, ctx())));
    expect(t).toContain('BB-6100 Opex · FT Fibertime · 2026-04: over budget');
    noFigures(t);
  });

  it('single approve, warn: budget_warnings carry no amounts; with read:reports they do', async () => {
    await setPolicy(pool, f, 'warn');
    const a = await ftBill('2026-05', 1500);
    const plain = JSON.parse(text(await committed(() => approveSupplierInvoiceTool.handler({ invoice_id: a, idempotency_key: `s1w-${a}` }, ctx()))));
    expect(plain.budget_warnings).toEqual(['Over budget: BB-6100 Opex · FT Fibertime · 2026-05: over budget']);
    const b = await ftBill('2026-05', 100);
    const full = JSON.parse(text(await committed(() => approveSupplierInvoiceTool.handler({ invoice_id: b, idempotency_key: `s1r-${b}` },
      ctx(['write:invoices', 'write:post', 'read:reports'])))));
    expect(full.budget_warnings[0]).toMatch(/remaining .*this bill/);
  });

  it('bulk dry run and live skip, block: reasons without amounts', async () => {
    await setPolicy(pool, f, 'block');
    const id = await ftBill('2026-06', 5000);
    const dry = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [id], dry_run: true, idempotency_key: `s1d-${id}` }, ctx()))));
    noFigures(dry.skipped[0].reason);
    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [id], idempotency_key: `s1l-${id}` }, ctx()))));
    expect(live.skipped[0].reason).toMatch(/^budget_exceeded: .*over budget/);
    noFigures(live.skipped[0].reason);
  });
});

describe('an all-refused bulk call frees its idempotency key (review round 3, reverting R5)', () => {
  it('every bill budget-refused: nothing posted, so "wrote nothing" (the key is free); the refused events stay', async () => {
    await setPolicy(pool, f, 'block');
    const id = await ftBill('2026-07', 5000);
    const res = await committed(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [id], idempotency_key: `r5-${id}` }, ctx()));
    expect(JSON.parse(text(res)).posted).toBe(0);
    expect(res.wroteNothing).toBe(true);
    expect((await eventsFor(pool, id)).map((e) => e.outcome)).toEqual(['refused']);
  });
});

describe('R2: the bulk tool takes the budget lock before any line-account lock', () => {
  it('blocked on a held line-account row, it already holds the company budget lock', async () => {
    await setPolicy(pool, f, 'block');
    const id = await ftBill('2026-08', 100);
    const holder = await pool.connect();
    const req = await openRequest(pool, f, f.owner);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [f.acc.opex]);
      const p = req.run(() => bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [id], idempotency_key: `r2-${id}` }, ctx()));
      let waiting = false;
      for (const until = Date.now() + 4000; Date.now() < until && !waiting;) {
        waiting = ((await pool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [req.pid])).rowCount ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting).toBe(true);
      // The company budget key itself (budget_check:<company>, seed 954), held while it waits on the account row.
      const advisory = await pool.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted AND objsubid = 1
        AND ((classid::BIGINT << 32) | objid::BIGINT) = hashtextextended('budget_check:' || $2, 954)`, [req.pid, f.co]);
      expect(advisory.rowCount).toBeGreaterThan(0);
      await holder.query('COMMIT');
      expect(JSON.parse(text(await p)).posted).toBe(1);
      await req.commit();
    } finally {
      await holder.query('ROLLBACK'); // after the COMMIT above: a no-op (PostgreSQL warns, does not raise)
      holder.release();
      await req.rollback();
    }
  });
});

describe('R7: the bulk route, Post to GL under block', () => {
  it('an approved bill with no journal, over budget: refused per item, no journal, the refused event kept', async () => {
    await setPolicy(pool, f, 'block');
    const over = await ftBill('2026-09', 5000, 'approved');
    const fits = await ftBill('2026-09', 100, 'approved');
    const r = await callRoute(bulkRoute as never, f, f.manager, '/api/accounting/supplier-invoices-bulk-action', { action: 'post_gl', invoiceIds: [over, fits] });
    expect(r.statusCode).toBe(200);
    const results = (r.body.data as { results: Array<{ invoiceId: string; ok: boolean; reason?: string }> }).results;
    expect(results.find((x) => x.invoiceId === over)).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED' });
    expect(results.find((x) => x.invoiceId === fits)).toMatchObject({ ok: true });
    expect((await billState(pool, over)).gl_journal_entry_id).toBeNull();
    expect((await billState(pool, fits)).gl_journal_entry_id).not.toBeNull();
    expect((await eventsFor(pool, over)).map((e) => [e.outcome, e.channel])).toEqual([['refused', 'bulk']]);
  });
});

describe('the bulk route is rate-limited per user, charged per id (review round 5)', () => {
  it('600 ids a minute: three 200-id calls pass, the fourth is 429', async () => {
    // Its own member: the limiter remembers a full key in memory for a few seconds, which no other case may meet.
    const user = crypto.randomUUID();
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'manager')", [f.co, user]);
    try {
      // An unknown action is refused at validation (nothing written), so the burst is cheap; it is still charged per id.
      const body = () => ({ action: 'demolish', invoiceIds: Array.from({ length: 200 }, () => crypto.randomUUID()) });
      const call = () => callRoute(bulkRoute as never, f, user, '/api/accounting/supplier-invoices-bulk-action', body());
      for (let i = 0; i < 3; i += 1) expect((await call()).statusCode).not.toBe(429);
      expect((await call()).statusCode).toBe(429);
    } finally {
      await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [`supplier-invoice-bulk:${user}`]);
      await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
      await pool.query('DELETE FROM users WHERE id = $1', [user]);
    }
  }, 60_000);
});
