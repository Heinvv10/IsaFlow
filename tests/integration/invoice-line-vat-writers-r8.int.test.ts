/**
 * #1701 review round 8 (the merge-queue gate's majors), against a real database, with the gate's own examples:
 * (1) a linked note's approval (auto_apply none) and an unlinked note's FIFO walk on the same typed invoice with R115 left
 *     take ONE common lock (the invoice's credit-note key, the walk's in one sorted set at step 2): exactly one consumes
 *     it, both orders (two connections).
 * (6) a note approved before migration 874 (linked, no allocation rows) reverses its invoice by posting's replay, so only
 *     its true excess counts as detached on another typed invoice.
 * (7) bulk_approve_credit_notes' dry run consumes what the live run's approvals apply (a standalone note settling the only
 *     typed invoice before a linked one): dry == live.
 * (8) a tax_rate with a third decimal is refused on REST and MCP in the same words.
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import creditNotesRoute from '../../pages/api/accounting/credit-notes';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { approveCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { untypeLines } from './helpers/lineVatFixture';
import { applyCreditNoteTool } from '@/lib/mcp/tools/writeApplyCreditNote';
import { bulkApproveCreditNotesTool } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import type { McpToolContext } from '@/lib/mcp/types';
import { callRoute, createUser } from './r035-approval.helpers';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';

type Res = Awaited<ReturnType<typeof callRoute>>;
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const errorOf = (r: Res) => (r.state.body as { error?: { message?: string; details?: { code?: string } } }).error;
const post = (route: Parameters<typeof callRoute>[0], url: string, body: Record<string, unknown>) =>
  callRoute(route, tokens[user]!, f.fx.companyId, 'POST', body, url);
const state = (invoiceId: string) => inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, invoiceId));
const ctx = (): McpToolContext => ({ companyId: f.fx.companyId, userId: f.fx.userId, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'],
  companyRole: 'owner', oauthAppId: null }) as unknown as McpToolContext;
/** REST apply with no amount: what fits. */
const apply = async (creditNoteId: string, invoiceId: string) => {
  const r = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId, invoiceId });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
};
/** MCP apply_credit_note with a named amount. */
const applyAmount = async (creditNoteId: string, invoiceId: string, amount: number) => {
  const r = J(await inTx(f.fx, () => applyCreditNoteTool.handler({ credit_note_id: creditNoteId, invoice_id: invoiceId, amount, idempotency_key: crypto.randomUUID() }, ctx())));
  expect(r.amount_applied, JSON.stringify(r)).toBe(amount);
};
const rowsOf = async (noteId: string) => sql`
  SELECT invoice_id, amount_allocated::FLOAT8 AS amount FROM credit_note_allocations WHERE credit_note_id = ${noteId}::UUID ORDER BY created_at, invoice_id`;
const counts = async () => ((await sql`
  SELECT (SELECT COUNT(*)::INT FROM credit_notes WHERE company_id = ${f.fx.companyId}::UUID) AS notes,
         (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID) AS journals`) as Record<string, number>[])[0]!;
/** A linked note on typed `invoiceId` for `subtotal` (no VAT given) is refused at create, nothing written. */
const refusedAt = async (invoiceId: string, clientId: string, date: string, subtotal: number) => {
  const before = await counts();
  const r = await post(creditNotesRoute, '/api/accounting/credit-notes', { type: 'customer', clientId, customerInvoiceId: invoiceId, creditDate: date, subtotal });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
  expect(errorOf(r)?.details?.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
  expect(await counts()).toEqual(before);
};
type Line = { description: string; quantity: number; unitPrice: number; vatType: string };
const typedInvoice = async (c: string, date: string, unitPrice = 100, items?: Line[]) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: c, invoiceDate: date,
    items: (items ?? [{ description: 'Standard', quantity: 1, unitPrice, vatType: 'standard' }]) as never,
  }))).id;
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A legacy (untyped) invoice, 100 at 15%: 115. */
const legacyInvoice = async (c: string, date: string) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: c, invoiceDate: date, taxRate: 15, items: [{ description: 'Legacy', quantity: 1, unitPrice: 100 }],
  }))).id;
  await untypeLines(id);
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A note (unlinked at 15% unless `linkedTo`), approved with nothing applied. */
const approvedNote = async (c: string, date: string, subtotal: number, linkedTo?: string) => {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: c, creditDate: date, subtotal, ...(linkedTo ? { customerInvoiceId: linkedTo } : { taxRate: 15 }),
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId, { autoApply: 'none' }));
  return cn;
};
/**
 * Runs `fn` in a transaction that is COMMITTED whatever it throws, and returns what it threw: a refusal "before any write"
 * is then proved by reading the committed state (inTx rolls a throw back, which would hide a write made before it).
 */
const committed = async (fn: () => Promise<unknown>): Promise<unknown> => {
  const c = await f.fx.pool.connect();
  await c.query('BEGIN');
  let thrown: unknown = null;
  try { await runOn(f.fx, c, fn); } catch (err) { thrown = err; }
  await c.query('COMMIT');
  c.release();
  expect(thrown, 'expected a refusal').not.toBeNull();
  return thrown;
};
const revenueTakes = async (noteId: string) => sql`
  SELECT is_excess, SUM(amount)::FLOAT8 AS amount FROM credit_note_revenue_allocations
  WHERE credit_note_id = ${noteId}::UUID GROUP BY is_excess ORDER BY is_excess`;

describeIfDisposable('per-line VAT writers, review round 8', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [f.fx.companyId, user, 'owner']);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await sql`DELETE FROM credit_note_revenue_allocations WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM mcp_tool_calls WHERE company_id = ${c}::UUID`;
    }
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await dropLineRevenue(f);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });
  const customer = async (name: string) => (await pool.query(`INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [f.fx.companyId, `${name} ${f.fx.tag}`])).rows[0].id as string;
  const draft = (c: string, date: string, subtotal: number, linkedTo?: string) => inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: c, creditDate: date, subtotal, ...(linkedTo ? { customerInvoiceId: linkedTo } : { taxRate: 15 }),
  }, f.fx.userId));
  const open = async () => {
    const client = await f.fx.pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return { client, pid };
  };
  /** Until `pid` waits on a lock or `p` settles (4 s at most): whether it waited. */
  const waitsOnLock = async (pid: number, p: Promise<unknown>) => {
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 80 && !settled; i++) {
      const r = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid]);
      if (r.rowCount) return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return false;
  };

  describe('(1) race: a linked approval (auto_apply none) and a FIFO walk on typed Y with 115 left', () => {
    const setup = async (name: string, d: string, approvedM: boolean) => {
      const c = await customer(name);
      const y = await typedInvoice(c, d);
      const l = await draft(c, d, 100, y);                                   // 100 + 15: all of Y
      expect(l.taxAmount).toBe(15);
      // Unlinked 115: a draft for approve's walk, or approved with nothing applied for auto_apply_unapplied's (which
      // posts no journal, so no journal-number lock can serialise the two for it).
      const m = approvedM ? await approvedNote(c, d, 100) : await draft(c, d, 100);
      return { c, y, l, m };
    };
    const backfill = (c: string) => autoApplyUnapplied({ companyId: f.fx.companyId, subledger: 'ar', entityId: c, userId: f.fx.userId, dryRun: false });
    /** Runs `first` to completion on one connection, then `second` on another; commits the first; settles both. */
    const race = async (first: () => Promise<unknown>, second: () => Promise<unknown>) => {
      const a = await open();
      const b = await open();
      try {
        await runOn(f.fx, a.client, first);
        const p = runOn(f.fx, b.client, second);
        const waited = await waitsOnLock(b.pid, p);
        await a.client.query('COMMIT');
        const outcome = await p.then(() => null, (err: unknown) => err);
        await b.client.query(outcome ? 'ROLLBACK' : 'COMMIT');
        return { waited, outcome };
      } finally {
        await a.client.query('ROLLBACK').catch(() => {}); a.client.release();
        await b.client.query('ROLLBACK').catch(() => {}); b.client.release();
      }
    };
    it('the linked approval first, the back-fill\'s walk second: it waits for Y\'s key, then finds nothing left there', async () => {
      const { c, y, l, m } = await setup('R8-1a', '2026-06-01', true);
      const r = await race(() => approveCreditNote(f.fx.companyId, l.id, f.fx.userId, { autoApply: 'none' }), () => backfill(c));
      expect(r).toEqual({ waited: true, outcome: null });
      expect(await rowsOf(m.id)).toEqual([]);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    });
    it('the back-fill\'s walk first, the linked approval second: it waits for Y\'s key, then is refused (nothing left)', async () => {
      const { c, y, l, m } = await setup('R8-1b', '2026-06-01', true);
      const r = await race(() => backfill(c), () => approveCreditNote(f.fx.companyId, l.id, f.fx.userId, { autoApply: 'none' }));
      expect(r.waited).toBe(true);
      expect(String(r.outcome)).toMatch(/credits 100\.00, but the invoice has 0\.00 left to credit/);
      expect(await rowsOf(m.id)).toEqual([{ invoice_id: y, amount: 115 }]);
      expect(await sql`SELECT status FROM credit_notes WHERE id = ${l.id}::UUID`).toEqual([{ status: 'draft' }]);
    });
    it('approve\'s own walk first, the linked approval second: refused the same way', async () => {
      const { y, l, m } = await setup('R8-1c', '2026-06-02', false);
      const r = await race(() => approveCreditNote(f.fx.companyId, m.id, f.fx.userId, { autoApply: 'fifo' }),
        () => approveCreditNote(f.fx.companyId, l.id, f.fx.userId, { autoApply: 'none' }));
      expect(r.waited).toBe(true);
      expect(String(r.outcome)).toMatch(/credits 100\.00, but the invoice has 0\.00 left to credit/);
      expect(await rowsOf(m.id)).toEqual([{ invoice_id: y, amount: 115 }]);
    });
  });

  describe('(6) a note approved before 874 (linked, no allocation rows): its D is only what the replay left over', () => {
    const preEight74 = async (noteId: string) => { await sql`DELETE FROM credit_note_revenue_allocations WHERE credit_note_id = ${noteId}::UUID`; };
    it('100 + 15 on legacy X wholly on its legs: its on-account 115 applied to typed Y counts nothing; a return on Y approves', async () => {
      const c = await customer('R8-6a');
      const x = await legacyInvoice(c, '2026-06-03');
      const y = await typedInvoice(c, '2026-06-03');
      const n = await approvedNote(c, '2026-06-04', 100, x);
      await preEight74(n.id);
      expect(await revenueTakes(n.id)).toEqual([]);
      await apply(n.id, y);
      expect(await rowsOf(n.id)).toEqual([{ invoice_id: y, amount: 115 }]);
      expect(await state(y)).toEqual({ remainingNet: 100, remainingVat: 15 });
      const r = await approvedNote(c, '2026-06-05', 100, y);
      expect(r.taxAmount).toBe(15);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    });
    it('200 + 30 on legacy X (100 replayed onto its leg): the excess 115 still counts on typed Y', async () => {
      const c = await customer('R8-6b');
      const x = await legacyInvoice(c, '2026-06-06');
      const y = await typedInvoice(c, '2026-06-06');
      const n = await approvedNote(c, '2026-06-07', 200, x);
      await preEight74(n.id);
      await apply(n.id, x);
      await apply(n.id, y);
      expect(await rowsOf(n.id)).toEqual([{ invoice_id: x, amount: 115 }, { invoice_id: y, amount: 115 }]);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      await refusedAt(y, c, '2026-06-07', 100);
    });
  });

  describe('(7) bulk_approve_credit_notes: the dry run consumes what the live approvals apply', () => {
    const run = async (ids: string[], dry: boolean) => J(await inTx(f.fx, () => bulkApproveCreditNotesTool.handler(
      { credit_note_ids: ids, idempotency_key: crypto.randomUUID(), ...(dry ? { dry_run: true } : {}) }, ctx())));
    const skippedOf = (r: Record<string, unknown>) => ((r.skipped as { document_id: string; reason: string }[]) ?? []).map((s) => [s.document_id, s.reason]);
    it('the gate\'s example: a standalone note settles the only typed invoice first, so the linked one is skipped in both', async () => {
      const c = await customer('R8-7a');
      const y = await typedInvoice(c, '2026-06-08');
      const u = await draft(c, '2026-06-08', 100);
      const l = await draft(c, '2026-06-08', 100, y);
      const dry = await run([l.id, u.id], true);
      expect(dry.would_post_ids).toEqual([u.id]);
      expect(skippedOf(dry)).toEqual([[l.id, expect.stringMatching(/^vat_split_refused: Credit note \S+ credits 100\.00, but the invoice has 0\.00 left to credit/)]]);
      const live = await run([l.id, u.id], false);
      expect((live.credit_notes as { id: string }[]).map((n) => n.id)).toEqual(dry.would_post_ids);
      expect(skippedOf(live)).toEqual(skippedOf(dry));
      expect(await rowsOf(u.id)).toEqual([{ invoice_id: y, amount: 115 }]);
    });
    it('partly: a standalone 40 + 6 leaves 60 / 9; of two linked notes (100 and 60) the live order posts what the dry run said', async () => {
      const c = await customer('R8-7b');
      const y = await typedInvoice(c, '2026-06-09');
      const u = await draft(c, '2026-06-09', 40);
      const big = await draft(c, '2026-06-09', 100, y);
      const fits = await draft(c, '2026-06-09', 60, y);
      expect(fits.taxAmount).toBe(9);
      const ids = [big.id, fits.id, u.id];
      const dry = await run(ids, true);
      const live = await run(ids, false);
      expect((live.credit_notes as { id: string }[]).map((n) => n.id).sort()).toEqual([...(dry.would_post_ids as string[])].sort());
      expect(skippedOf(live)).toEqual(skippedOf(dry));
      expect(skippedOf(dry).map(([id]) => id)).toEqual([big.id]);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    });
  });

  describe('(8) a tax rate past two decimals is refused on both surfaces, in the same words', () => {
    it('REST: 10,000 at 15.005 with VAT 1,500.50 is a 400; MCP create_credit_note refuses it the same way', async () => {
      const c = await customer('R8-8');
      const before = await counts();
      const r = await post(creditNotesRoute, '/api/accounting/credit-notes', { type: 'customer', clientId: c, creditDate: '2026-06-10', subtotal: 10000, taxRate: 15.005, taxAmount: 1500.5 });
      expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
      expect(errorOf(r)?.message).toBe('taxRate must have at most two decimal places (it is stored to the hundredth)');
      const t = await inTx(f.fx, () => createCreditNoteTool.handler({ type: 'customer', client_id: c, credit_date: '2026-06-10', subtotal: 10000, tax_rate: 15.005, tax_amount: 1500.5, idempotency_key: crypto.randomUUID() }, ctx()));
      expect(t.isError).toBe(true);
      expect(t.content[0]!.text).toContain('tax_rate must have at most two decimal places (it is stored to the hundredth)');
      expect(await counts()).toEqual(before);
    });
  });
});
