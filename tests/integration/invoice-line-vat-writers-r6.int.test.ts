/**
 * #1701 round 6, RULE A (the M1 fix), against a real database. A note's DETACHED gross D = total x (subtotal - its
 * non-excess revenue allocations) / subtotal; its applications to invoices whose legs it did not reverse count there,
 * in application order, until D is used up (ar/creditNoteDetached). Cases:
 * (1) the counter-example: N linked to legacy X 200 + 30 (100 on X's leg, 100 excess: D 115) applied 115 to X and 115
 *     to typed Y: Y's capacity is used by N's 115; a linked note on Y is limited to the true remainder.
 * (2) the 180-vs-115 case: L linked to typed Y (D 0) spilling 65 onto typed W: W's capacity is untouched and a genuine
 *     linked return on W approves; the back-fill's dry run consumes W by what L counts there (nothing).
 * (3) the earlier HIGH, both orders: unlinked U applied to typed Y and to legacy Z (which late-links U to Z): Y keeps
 *     counting U; a linked note on Y is limited to the true remainder.
 * (4) a note linked to legacy X wholly on its legs (D 0): its leftover applied to typed Y counts nowhere.
 * (5) unapply, an adjustment down and cancel give D back and re-derive it in application order.
 * (5b) ...but never onto a later typed invoice past what it has left: an unapply or an adjustment down that would raise
 *      another typed invoice's count beyond its capacity is refused before any write, live and dry run.
 * Exact cents (6) is the unit suite (creditNoteDetached.test). Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import creditNotesRoute from '../../pages/api/accounting/credit-notes';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { approveCreditNote, cancelCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { planCreditNoteUnapply, unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { untypeLines } from './helpers/lineVatFixture';
import { applyCreditNoteTool } from '@/lib/mcp/tools/writeApplyCreditNote';
import { adjustCreditNoteApplicationTool } from '@/lib/mcp/tools/writeAdjustCreditNoteApplication';
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
const revenueTakes = async (noteId: string) => sql`
  SELECT is_excess, SUM(amount)::FLOAT8 AS amount FROM credit_note_revenue_allocations
  WHERE credit_note_id = ${noteId}::UUID GROUP BY is_excess ORDER BY is_excess`;

describeIfDisposable('per-line VAT writers, review round 6: rule A', () => {
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

  it('(1) N linked to legacy X 200 + 30 (D 115) applied 115 to X and 115 to typed Y: Y counts 115; a linked note is held to the true remainder', async () => {
    const c = await customer('R6-1');
    const x = await legacyInvoice(c, '2026-11-01');
    const y = await typedInvoice(c, '2026-11-01');
    const n = await approvedNote(c, '2026-11-02', 200, x);
    expect(n.taxAmount).toBe(30);
    expect(await revenueTakes(n.id)).toEqual([{ is_excess: false, amount: 100 }, { is_excess: true, amount: 100 }]);
    await apply(n.id, x);
    await apply(n.id, y);
    expect(await rowsOf(n.id)).toEqual([{ invoice_id: x, amount: 115 }, { invoice_id: y, amount: 115 }]);
    expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    await refusedAt(y, c, '2026-11-03', 100);

    // The same on a 200 + 30 typed invoice: N's 115 counts, 100 / 15 is the true remainder a linked note defaults to.
    const x2 = await legacyInvoice(c, '2026-11-04');
    const y2 = await typedInvoice(c, '2026-11-04', 200);
    const n2 = await approvedNote(c, '2026-11-05', 200, x2);
    await apply(n2.id, x2);
    await apply(n2.id, y2);
    expect(await state(y2)).toEqual({ remainingNet: 100, remainingVat: 15 });
    await refusedAt(y2, c, '2026-11-05', 100.01);
    const l = await approvedNote(c, '2026-11-05', 100, y2);
    expect(l.taxAmount).toBe(15);
    expect(await state(y2)).toEqual({ remainingNet: 0, remainingVat: 0 });
  });

  it('(2) L linked to typed Y (D 0) spilling 65 onto typed W by the back-fill: W untouched, a genuine return on W approves', async () => {
    const c = await customer('R6-2');
    const w = await typedInvoice(c, '2026-11-06');                         // older: the back-fill reaches it first
    const y = await typedInvoice(c, '2026-11-07');
    const l = await approvedNote(c, '2026-11-08', 100, y);                 // 100 + 15, wholly on Y's legs
    expect(l.taxAmount).toBe(15);
    expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    await applyAmount(l.id, y, 50);
    const req = { companyId: f.fx.companyId, subledger: 'ar' as const, entityId: c, userId: f.fx.userId };
    const lines = (p: Awaited<ReturnType<typeof autoApplyUnapplied>>) => p.applications.map((a) => [a.payment_id, a.lines.map((x) => [x.document_id, x.amount])]);
    const dry = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: true }));
    const live = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: false }));
    expect(lines(live)).toEqual(lines(dry));
    expect(lines(live)).toEqual([[l.id, [[w, 65]]]]);
    expect(await state(w)).toEqual({ remainingNet: 100, remainingVat: 15 });
    const r = await approvedNote(c, '2026-11-09', 100, w);                 // the genuine return on W
    expect(r.taxAmount).toBe(15);
    expect(await state(w)).toEqual({ remainingNet: 0, remainingVat: 0 });
  });

  it('(2b) the back-fill\'s dry run consumes a typed invoice by what each note COUNTS there, so it plans what the live run writes', async () => {
    const c = await customer('R6-2b');
    const w = await typedInvoice(c, '2026-11-10');
    const y = await typedInvoice(c, '2026-11-11');
    const q = await legacyInvoice(c, '2026-11-12');
    const r0 = await approvedNote(c, '2026-11-10', 50, w);                 // reverses 50 + 7.50 of W, applied to Q
    await apply(r0.id, q);
    expect(await state(w)).toEqual({ remainingNet: 50, remainingVat: 7.5 });  // 57.50 left, 115 outstanding
    const l = await approvedNote(c, '2026-11-11', 100, y);                 // D 0
    await applyAmount(l.id, y, 35);
    const u = await approvedNote(c, '2026-11-13', 100);                    // unlinked 115, D 115
    const req = { companyId: f.fx.companyId, subledger: 'ar' as const, entityId: c, userId: f.fx.userId };
    const lines = (p: Awaited<ReturnType<typeof autoApplyUnapplied>>) => p.applications.map((a) => [a.payment_id, a.lines.map((x) => [x.document_id, x.amount])]);
    const dry = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: true }));
    const live = await inTx(f.fx, () => autoApplyUnapplied({ ...req, dryRun: false }));
    // L: W capped at its 57.50, the rest to its own Y. L counts nothing on W, so U still finds 57.50 there.
    expect(lines(live)).toEqual([[l.id, [[w, 57.5], [y, 22.5]]], [u.id, [[w, 57.5], [q, 57.5]]]]);
    expect(lines(dry)).toEqual(lines(live));
    expect(await state(w)).toEqual({ remainingNet: 0, remainingVat: 0 });
  });

  describe('(3) the earlier HIGH: unlinked U on typed Y and legacy Z (Z late-links U), both orders', () => {
    const run = async (name: string, d: string, zFirst: boolean) => {
      const c = await customer(name);
      const y = await typedInvoice(c, d);
      const z = await legacyInvoice(c, d);
      const u = await approvedNote(c, d, 200);                             // 200 + 30, D 230
      if (zFirst) await apply(u.id, z);
      await applyAmount(u.id, y, 60);
      if (!zFirst) await apply(u.id, z);
      expect(((await sql`SELECT customer_invoice_id FROM credit_notes WHERE id = ${u.id}::UUID`) as { customer_invoice_id: string }[])[0]!.customer_invoice_id).toBe(z);
      expect(await revenueTakes(u.id)).toEqual([{ is_excess: true, amount: 200 }]);
      // 60 of Y's 115: VAT 60 x 15 / 115 = 7.83, net 52.17; left 47.83 / 7.17.
      expect(await state(y)).toEqual({ remainingNet: 47.83, remainingVat: 7.17 });
      await refusedAt(y, c, d, 47.84);
      const l = await approvedNote(c, d, 47.83, y);
      expect(l.taxAmount).toBe(7.17);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    };
    it('typed Y first, then legacy Z', () => run('R6-3a', '2026-11-14', false));
    it('legacy Z first, then typed Y', () => run('R6-3b', '2026-11-15', true));
  });

  it('(4) N linked to legacy X 100 + 15 wholly on its legs (D 0): its leftover on typed Y counts nowhere', async () => {
    const c = await customer('R6-4');
    const x = await legacyInvoice(c, '2026-11-16');
    const y = await typedInvoice(c, '2026-11-16');
    const n = await approvedNote(c, '2026-11-17', 100, x);
    expect(n.taxAmount).toBe(15);
    expect(await revenueTakes(n.id)).toEqual([{ is_excess: false, amount: 100 }]);
    await applyAmount(n.id, x, 50);
    await apply(n.id, y);
    expect(await rowsOf(n.id)).toEqual([{ invoice_id: x, amount: 50 }, { invoice_id: y, amount: 65 }]);
    expect(await state(y)).toEqual({ remainingNet: 100, remainingVat: 15 });
    const r = await approvedNote(c, '2026-11-17', 100, y);                 // a genuine return on Y: all of it
    expect(r.taxAmount).toBe(15);
  });

  it('(5) unapply, an adjustment down and cancel give D back and re-derive it in application order', async () => {
    const c = await customer('R6-5');
    const x = await legacyInvoice(c, '2026-11-18');
    const y = await typedInvoice(c, '2026-11-18');
    const w = await typedInvoice(c, '2026-11-19');
    const n = await approvedNote(c, '2026-11-20', 150, x);                 // 150 + 22.50: 100 on X's leg, D 57.50
    expect(n.taxAmount).toBe(22.5);
    await applyAmount(n.id, x, 20);
    await applyAmount(n.id, y, 57.5);
    await apply(n.id, w);                                                   // 95: what is left of the note
    expect(await rowsOf(n.id)).toEqual([{ invoice_id: x, amount: 20 }, { invoice_id: y, amount: 57.5 }, { invoice_id: w, amount: 95 }]);
    expect(await state(y)).toEqual({ remainingNet: 50, remainingVat: 7.5 });  // D 57.50 used up on Y
    expect(await state(w)).toEqual({ remainingNet: 100, remainingVat: 15 });  // nothing left of D for W

    const down = await inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
      { credit_note_id: n.id, document_id: y, new_amount: 20, idempotency_key: crypto.randomUUID() }, ctx()));
    expect(down.isError, down.content[0]!.text).toBeFalsy();
    // Y counts 20 (VAT 2.61), W the 37.50 of D left (VAT 4.89).
    expect(await state(y)).toEqual({ remainingNet: 82.61, remainingVat: 12.39 });
    expect(await state(w)).toEqual({ remainingNet: 67.39, remainingVat: 10.11 });
    // An adjustment keeps the application's place in the order: up again, Y takes D back from W.
    const up = await inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
      { credit_note_id: n.id, document_id: y, new_amount: 57.5, idempotency_key: crypto.randomUUID() }, ctx()));
    expect(up.isError, up.content[0]!.text).toBeFalsy();
    expect(await rowsOf(n.id)).toEqual([{ invoice_id: x, amount: 20 }, { invoice_id: y, amount: 57.5 }, { invoice_id: w, amount: 95 }]);
    expect(await state(y)).toEqual({ remainingNet: 50, remainingVat: 7.5 });
    expect(await state(w)).toEqual({ remainingNet: 100, remainingVat: 15 });

    await inTx(f.fx, () => unapplyCreditNote(f.fx.companyId, { creditNoteId: n.id, invoiceId: y }, f.fx.userId));
    expect(await state(y)).toEqual({ remainingNet: 100, remainingVat: 15 });
    expect(await state(w)).toEqual({ remainingNet: 50, remainingVat: 7.5 });

    await inTx(f.fx, () => cancelCreditNote(f.fx.companyId, n.id, f.fx.userId, 'round 6'));
    expect(await state(w)).toEqual({ remainingNet: 100, remainingVat: 15 });
  });

  it('(5b) an unapply or adjustment down that would move D onto a fully credited later typed invoice is refused before any write', async () => {
    const c = await customer('R6-5b');
    const x = await legacyInvoice(c, '2026-11-21');
    const y = await typedInvoice(c, '2026-11-21');
    const w = await typedInvoice(c, '2026-11-22');
    const n = await approvedNote(c, '2026-11-23', 150, x);                 // D 57.50
    await applyAmount(n.id, x, 20);
    await applyAmount(n.id, y, 57.5);
    await apply(n.id, w);                                                   // 95, counting nothing on W
    const r = await approvedNote(c, '2026-11-23', 80, w);                  // a genuine return on W: 80 + 12, 23 left
    expect(r.taxAmount).toBe(12);
    expect(await state(w)).toEqual({ remainingNet: 20, remainingVat: 3 });
    const snapshot = async () => [await rowsOf(n.id), await state(y), await state(w),
      await sql`SELECT id, amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id IN (${x}::UUID, ${y}::UUID, ${w}::UUID) ORDER BY id`];
    const before = await snapshot();

    // Unapply from Y: W would count 57.50 with 23 left.
    await expect(inTx(f.fx, () => planCreditNoteUnapply(f.fx.companyId, { creditNoteId: n.id, invoiceId: y })))
      .rejects.toThrow(/would move 57\.50 of its credit onto invoice \S+, which has 23\.00 left to credit/);
    await expect(inTx(f.fx, () => unapplyCreditNote(f.fx.companyId, { creditNoteId: n.id, invoiceId: y }, f.fx.userId)))
      .rejects.toThrow(/would move 57\.50 of its credit onto invoice \S+, which has 23\.00 left to credit/);
    expect(await snapshot()).toEqual(before);

    // Adjust Y down to 34.49: W would count 23.01. Refused live and dry run; 34.50 (W exactly full) is allowed.
    const adjust = (amount: number, dry: boolean) => inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
      { credit_note_id: n.id, document_id: y, new_amount: amount, idempotency_key: crypto.randomUUID(), ...(dry ? { dry_run: true } : {}) }, ctx()));
    for (const dry of [true, false]) {
      const refused = await adjust(34.49, dry);
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/would move 23\.01 of its credit onto invoice \S+, which has 23\.00 left to credit/);
    }
    expect(await snapshot()).toEqual(before);
    const ok = await adjust(34.5, false);
    expect(ok.isError, ok.content[0]!.text).toBeFalsy();
    expect(await state(w)).toEqual({ remainingNet: 0, remainingVat: 0 });
    expect(await state(y)).toEqual({ remainingNet: 70, remainingVat: 10.5 });

    // Taking back what reversed X's legs moves no D; taking back everything lowers every count.
    await inTx(f.fx, () => unapplyCreditNote(f.fx.companyId, { creditNoteId: n.id, invoiceId: x }, f.fx.userId));
    await inTx(f.fx, () => unapplyCreditNote(f.fx.companyId, { creditNoteId: n.id }, f.fx.userId));
    expect(await state(y)).toEqual({ remainingNet: 100, remainingVat: 15 });
    expect(await state(w)).toEqual({ remainingNet: 20, remainingVat: 3 });
  });
});
