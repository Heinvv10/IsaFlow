/**
 * #1701 review round 9, against a real database:
 * - LEDGER MEDIUM: auto_apply_unapplied applies every source in ONE transaction; a receipt source locks the customer's
 *   invoice rows, and a later credit-note source's walk took the credit-note keys AFTER them, so an approval holding the
 *   key (note row, key, journal, rows) and waiting for the row deadlocked with it (40P01). The run now takes its
 *   credit-note sources' note rows and keys before its first source (shared/autoApplyBackfillLocks): the approval waits
 *   on the KEY (advisory), nothing deadlocks. Two connections, the back-fill paused between its two sources.
 * (LOW 2, a typed invoice with a negative revenue leg, is a unit case: the invoice writers refuse a negative line, so
 *  only a hand-made journal carries one; tests/unit/mcp/creditNoteVatDryRunFifo.)
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import creditNotesRoute from '../../pages/api/accounting/credit-notes';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { approveCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn, seedBankTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { untypeLines } from './helpers/lineVatFixture';
import { applyCreditNoteTool } from '@/lib/mcp/tools/writeApplyCreditNote';
import { bulkApproveCreditNotesTool } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { lockWaitOf } from './helpers/lockWait';
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


// The back-fill's credit-note sources pause at a gate the test opens, so a second request can run between a receipt
// source (which locks the customer's invoice rows) and the credit-note source after it.
const gate = vi.hoisted(() => ({ reached: null as null | (() => void), go: null as null | Promise<void> }));
vi.mock('@/modules/accounting/services/shared/autoApplyBackfillApply', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/shared/autoApplyBackfillApply')>();
  return {
    ...actual,
    applyOneCreditNote: async (...args: Parameters<typeof actual.applyOneCreditNote>) => {
      if (gate.reached) { gate.reached(); gate.reached = null; await gate.go; }
      return actual.applyOneCreditNote(...args);
    },
  };
});
describeIfDisposable('per-line VAT writers, review round 9', () => {
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
      // The receipts this suite records (dropLineRevenue removes invoices before payments).
      await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM customer_payments WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM bank_allocation_batch_lines WHERE batch_id IN (SELECT id FROM bank_allocation_batches WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM bank_allocation_batches WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
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
  /** An unapplied receipt for `c` on `date`, recorded with nothing applied. */
  const receipt = async (c: string, date: string, amount: number) => {
    const tx = await seedBankTx(f.fx, { date, amount, description: 'RECEIPT' });
    await inTx(f.fx, () => allocateTransaction(f.fx.companyId, tx, null, f.fx.userId, undefined, 'customer', c,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' }));
  };

  it('a receipt source then a credit-note source in one back-fill, an approval linked to the same typed invoice between them: it waits on the key, no deadlock', async () => {
    const c = await customer('R9-1');
    const x = await typedInvoice(c, '2026-05-01');
    await receipt(c, '2026-05-01', 50);
    const n = await approvedNote(c, '2026-05-02', 100);                     // unlinked 115, a back-fill source after the receipt
    const d = await draft(c, '2026-05-03', 20, x);                          // linked 20 + 3, approved with auto_apply 'linked'
    const a = await open();
    const b = await open();
    try {
      let go!: () => void;
      gate.go = new Promise<void>((r) => { go = r; });
      const reached = new Promise<void>((r) => { gate.reached = r; });
      const backfill = runOn(f.fx, a.client, () => autoApplyUnapplied({ companyId: f.fx.companyId, subledger: 'ar', entityId: c, userId: f.fx.userId, dryRun: false }));
      await reached;                                                       // the receipt source has locked X's row
      const approval = runOn(f.fx, b.client, () => approveCreditNote(f.fx.companyId, d.id, f.fx.userId, { autoApply: 'linked' }));
      const waitedOn = await lockWaitOf(pool, b.pid, a.pid, approval);
      go();
      const plan = await backfill;
      await a.client.query('COMMIT');
      await approval;
      await b.client.query('COMMIT');
      expect(waitedOn).toBe('advisory');
      expect(plan.failed).toEqual([]);
      expect(plan.applications.map((p) => [p.payment_id === n.id ? 'note' : 'receipt', p.lines.map((l) => [l.document_id, l.amount])]))
        .toEqual([['receipt', [[x, 50]]], ['note', [[x, 65]]]]);
      expect(await sql`SELECT status FROM credit_notes WHERE id = ${d.id}::UUID`).toEqual([{ status: 'approved' }]);
    } finally {
      gate.reached = null;
      await a.client.query('ROLLBACK').catch(() => {}); a.client.release();
      await b.client.query('ROLLBACK').catch(() => {}); b.client.release();
    }
  }, 60_000);

  it('round 11 MAJOR 2: a credit-note source another request holds is skipped and reported; the other sources still apply', async () => {
    const c = await customer('R11-2');
    const x = await legacyInvoice(c, '2026-05-11');
    const held = await approvedNote(c, '2026-05-11', 20);                    // 23, locked by another request below
    const free = await approvedNote(c, '2026-05-12', 30);                    // 34.50
    const other = await open();
    try {
      await other.client.query('SELECT id FROM credit_notes WHERE id = $1 FOR UPDATE', [held.id]);
      const plan = await inTx(f.fx, () => autoApplyUnapplied({ companyId: f.fx.companyId, subledger: 'ar', entityId: c, userId: f.fx.userId, dryRun: false }));
      expect(plan.failed).toEqual([{ payment_id: held.id, payment_number: expect.any(String),
        error: expect.stringMatching(/^Credit note \S+ is being changed by another request \(an approval, apply, unapply or cancel\); it was skipped/) }]);
      expect(plan.applications.filter((a) => a.payment_id === free.id).map((a) => a.lines.map((l) => [l.document_id, l.amount]))).toEqual([[[x, 34.5]]]);
    } finally {
      await other.client.query('ROLLBACK').catch(() => {}); other.client.release();
    }
    expect(await rowsOf(held.id)).toEqual([]);
    expect(await rowsOf(free.id)).toEqual([{ invoice_id: x, amount: 34.5 }]);
  }, 60_000);

  describe('create_credit_note replay by external_ref: the party and the linked invoice are part of the match', () => {
    const create = (c: string, invoiceId: string, ref: string, subtotal = 40) => inTx(f.fx, () => createCreditNoteTool.handler({
      type: 'customer', client_id: c, customer_invoice_id: invoiceId, credit_date: '2026-05-06', subtotal, reason: 'Return',
      external_system: 'sage', external_ref: ref, idempotency_key: crypto.randomUUID() }, ctx()));
    const notesWith = async (ref: string) => sql`SELECT id FROM credit_notes WHERE company_id = ${f.fx.companyId}::UUID AND external_ref = ${ref}`;

    it('a note with no figure on a typed invoice, approved (its VAT moved), replays cleanly; the same ref for another invoice is refused', async () => {
      const c = await customer('R9-3a');
      const y = await typedInvoice(c, '2026-05-06');
      const y2 = await typedInvoice(c, '2026-05-06');
      const made = J(await create(c, y, 'CRET-9A'));
      await inTx(f.fx, () => approveCreditNote(f.fx.companyId, String(made.id), f.fx.userId, { autoApply: 'none' }));
      expect(J(await create(c, y, 'CRET-9A'))).toMatchObject({ already_existed: true, payload_differs: false, id: made.id });
      const other = await create(c, y2, 'CRET-9A');
      expect(other.isError).toBe(true);
      expect(other.content[0]!.text).toMatch(/^external_ref CRET-9A \(sage\) is already used by credit note \S+ for a different customer_invoice_id/);
      expect(await notesWith('CRET-9A')).toEqual([{ id: made.id }]);
    });
    it('the same ref for another customer is refused, naming client_id; nothing written', async () => {
      const c = await customer('R9-3b');
      const c2 = await customer('R9-3b2');
      const y = await typedInvoice(c, '2026-05-07');
      const y2 = await typedInvoice(c2, '2026-05-07');
      const made = J(await create(c, y, 'CRET-9B'));
      const other = await create(c2, y2, 'CRET-9B');
      expect(other.isError).toBe(true);
      expect(other.content[0]!.text).toMatch(/for a different client_id and customer_invoice_id/);
      expect(await notesWith('CRET-9B')).toEqual([{ id: made.id }]);
    });

    it('round 10: two live notes on one ref (no unique index), each retried, is each one\'s replay; a third invoice is refused naming both', async () => {
      const c = await customer('R10-1');
      const y = await typedInvoice(c, '2026-05-08');
      const y2 = await typedInvoice(c, '2026-05-08');
      const y3 = await typedInvoice(c, '2026-05-08');
      const a = J(await create(c, y, 'CRET-10A'));
      const b = J(await create(c, y2, 'CRET-10A-TMP'));
      await sql`UPDATE credit_notes SET external_ref = 'CRET-10A' WHERE id = ${String(b.id)}::UUID`;   // a second live row on the ref
      expect(J(await create(c, y2, 'CRET-10A'))).toMatchObject({ already_existed: true, payload_differs: false, id: b.id });
      expect(J(await create(c, y, 'CRET-10A'))).toMatchObject({ already_existed: true, payload_differs: false, id: a.id });
      const third = await create(c, y3, 'CRET-10A');
      expect(third.isError).toBe(true);
      expect(third.content[0]!.text).toMatch(/already used by credit notes \S+ and \S+ for a different customer_invoice_id/);
      expect(await notesWith('CRET-10A')).toHaveLength(2);
    });
    it('round 10: after a customer merge (S into T) a retry naming S is refused before any write (its invoice is T\'s now)', async () => {
      const s = await customer('R10-2s');
      const t = await customer('R10-2t');
      const y = await typedInvoice(s, '2026-05-09');
      const made = J(await create(s, y, 'CRET-10B'));
      // What the merge re-points (customerMergeService): the note's and the invoice's customer.
      await sql`UPDATE credit_notes SET client_id = ${t}::UUID WHERE id = ${String(made.id)}::UUID`;
      await sql`UPDATE customer_invoices SET client_id = ${t}::UUID, customer_id = ${t}::UUID WHERE id = ${y}::UUID`;
      const again = await create(s, y, 'CRET-10B');
      expect(again.isError).toBe(true);
      expect(await notesWith('CRET-10B')).toEqual([{ id: made.id }]);
      // Retried for T (the surviving customer), it is the note's replay.
      expect(J(await create(t, y, 'CRET-10B'))).toMatchObject({ already_existed: true, id: made.id });
    });
    it('round 10: a draft whose linked invoice was changed since: a retry naming the old invoice is refused, naming the field and the note', async () => {
      const c = await customer('R10-3');
      const y = await typedInvoice(c, '2026-05-10');
      const y2 = await typedInvoice(c, '2026-05-10');
      const made = J(await create(c, y, 'CRET-10C'));
      await sql`UPDATE credit_notes SET customer_invoice_id = ${y2}::UUID WHERE id = ${String(made.id)}::UUID`;   // the draft re-linked
      const again = await create(c, y, 'CRET-10C');
      expect(again.isError).toBe(true);
      const [{ number }] = (await sql`SELECT credit_note_number AS number FROM credit_notes WHERE id = ${String(made.id)}::UUID`) as { number: string }[];
      expect(again.content[0]!.text).toMatch(new RegExp(`for a different customer_invoice_id: .* The existing note is ${number}\\.`));
      expect(await notesWith('CRET-10C')).toEqual([{ id: made.id }]);
    });
  });
});