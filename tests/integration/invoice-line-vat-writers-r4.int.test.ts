/**
 * #1701 review round 4, against a real database:
 * - HIGH: a note applied to a typed invoice Y counts against Y whatever it is linked to, except a note linked to Y
 *   itself, which counts once through its link. Applying an unlinked note to legacy Z links it to Z (COALESCE); its
 *   earlier application to Y stopped counting on Y, so Y could be credited twice. Both orders, and a note linked at
 *   creation to X whose leftover is applied to Y.
 * - The rule since round 4 (decided): an applied note not linked to the invoice uses the invoice's GROSS credit capacity,
 *   split in the invoice's OWN remaining proportion (the note posted its own VAT at its approval): a standard note
 *   applies to a zero-rated, exempt or mixed typed invoice, and a linked note then defaults to the true remainder;
 *   23 applications of 0.05 to a 1.00 / 0.15 invoice count exactly 1.00 / 0.15 (rounded once on their sum).
 * - LOW A: an application past the invoice's remaining gross is refused before any write on REST apply, MCP
 *   apply_credit_note (live and dry run) and adjust_credit_note_application; approve's FIFO walk skips that invoice.
 * - LOW C: the 33.30 cent edge through invoiceCreditBasis.
 *
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
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteApplyToInvoice';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
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
const data = <T>(r: Res) => (r.state.body as { data: T }).data;
const errorOf = (r: Res) => (r.state.body as { error?: { message?: string; details?: { code?: string } } }).error;
const post = (route: Parameters<typeof callRoute>[0], url: string, body: Record<string, unknown>) =>
  callRoute(route, tokens[user]!, f.fx.companyId, 'POST', body, url);
const state = (invoiceId: string) => inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, invoiceId));
const apply = async (creditNoteId: string, invoiceId: string) => {
  const r = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId, invoiceId });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
};
const linkOf = async (id: string) => ((await sql`SELECT customer_invoice_id FROM credit_notes WHERE id = ${id}::UUID`) as { customer_invoice_id: string | null }[])[0]!.customer_invoice_id;
/** A linked note on a typed invoice with nothing left is refused at create (no VAT given), nothing written. */
const refusedOn = async (invoiceId: string, date: string) => {
  const before = await counts();
  const r = await post(creditNotesRoute, '/api/accounting/credit-notes', { type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate: date, subtotal: 100 });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
  expect(errorOf(r)?.details?.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
  expect(await counts()).toEqual(before);
};
const counts = async () => ((await sql`
  SELECT (SELECT COUNT(*)::INT FROM credit_notes WHERE company_id = ${f.fx.companyId}::UUID) AS notes,
         (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID) AS journals,
         (SELECT COUNT(*)::INT FROM credit_note_revenue_allocations WHERE company_id = ${f.fx.companyId}::UUID) AS takes`) as Record<string, number>[])[0]!;
const ctx = (): McpToolContext => ({ companyId: f.fx.companyId, userId: f.fx.userId, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'],
  companyRole: 'owner', oauthAppId: null }) as unknown as McpToolContext;
type Line = { description: string; quantity: number; unitPrice: number; vatType: string };
const typedInvoice = async (date: string, unitPrice = 100, items?: Line[], clientId?: string) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: clientId ?? f.fx.customerId, invoiceDate: date,
    items: (items ?? [{ description: 'Standard', quantity: 1, unitPrice, vatType: 'standard' }]) as never,
  }))).id;
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A legacy (untyped) invoice, 100 at 15%: 115. */
const legacyInvoice = async (date: string) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, taxRate: 15, items: [{ description: 'Legacy', quantity: 1, unitPrice: 100 }],
  }))).id;
  await untypeLines(id);
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** A note at 15% (unlinked unless `linkedTo`), approved with nothing applied. */
const approvedNote = async (date: string, subtotal: number, linkedTo?: string, opts: { taxRate?: number; clientId?: string; fifo?: boolean } = {}) => {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: opts.clientId ?? f.fx.customerId, creditDate: date, subtotal,
    ...(linkedTo ? { customerInvoiceId: linkedTo } : { taxRate: opts.taxRate ?? 15 }),
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId, { autoApply: opts.fifo ? 'fifo' : 'none' }));
  return cn;
};

describeIfDisposable('per-line VAT writers, review round 4', () => {
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

  describe('HIGH: a note applied to a typed invoice counts there however it is linked elsewhere', () => {
    it('typed Y first, then legacy Z (which links the note to Z): Y stays fully credited, a linked note on Y is refused', async () => {
      const y = await typedInvoice('2026-10-20');
      const z = await legacyInvoice('2026-10-20');
      const u = await approvedNote('2026-10-21', 200);          // 200 + 30
      await apply(u.id, y);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      await apply(u.id, z);
      expect(await linkOf(u.id)).toBe(z);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      await refusedOn(y, '2026-10-22');
    });

    it('legacy Z first (linking the note to Z), then typed Y: the application to Y counts', async () => {
      const y = await typedInvoice('2026-10-23');
      const z = await legacyInvoice('2026-10-23');
      const u = await approvedNote('2026-10-24', 200);
      await apply(u.id, z);
      expect(await linkOf(u.id)).toBe(z);
      await apply(u.id, y);
      expect(await linkOf(u.id)).toBe(z);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      await refusedOn(y, '2026-10-25');
    });

    it('a note linked at creation to X, its leftover applied to typed Y: counts on Y; a note linked to Y itself counts once', async () => {
      const x = await legacyInvoice('2026-10-26');
      const y = await typedInvoice('2026-10-26');
      const n = await approvedNote('2026-10-27', 200, x);
      await apply(n.id, x);
      await apply(n.id, y);
      expect(await linkOf(n.id)).toBe(x);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      await refusedOn(y, '2026-10-28');

      // Linked to Y and applied to Y: by the link only (its application is not counted a second time).
      const y2 = await typedInvoice('2026-10-29');
      const l = await approvedNote('2026-10-29', 40, y2);       // 40 + 6.00, the required figure on 100 / 15
      expect(l.taxAmount).toBe(6);
      await apply(l.id, y2);
      expect(await state(y2)).toEqual({ remainingNet: 60, remainingVat: 9 });
    });
  });

  describe('the rule: an applied note uses the invoice\'s gross credit capacity, in the invoice\'s own proportion', () => {
    it('a standard note onto a ZERO-RATED typed invoice applies; a linked note then defaults to the true remainder (VAT 0)', async () => {
      const y = await typedInvoice('2026-11-02', 0, [{ description: 'Zero', quantity: 1, unitPrice: 200, vatType: 'zero_rated' }]);
      expect(await state(y)).toEqual({ remainingNet: 200, remainingVat: 0 });
      const u = await approvedNote('2026-11-02', 50);           // 50 + 7.50
      await apply(u.id, y);
      expect(await state(y)).toEqual({ remainingNet: 142.5, remainingVat: 0 });
      const l = data<{ id: string; taxAmount: number }>(await post(creditNotesRoute, '/api/accounting/credit-notes', {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: y, creditDate: '2026-11-02', subtotal: 142.5 }));
      expect(l.taxAmount).toBe(0);
      const ok = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'approve', creditNoteId: l.id, autoApply: 'none' });
      expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    });

    it('a standard note onto an EXEMPT typed invoice applies the same way', async () => {
      const y = await typedInvoice('2026-11-03', 0, [{ description: 'Exempt', quantity: 1, unitPrice: 300, vatType: 'exempt' }]);
      const u = await approvedNote('2026-11-03', 100);          // 100 + 15
      await apply(u.id, y);
      expect(await state(y)).toEqual({ remainingNet: 185, remainingVat: 0 });
    });

    it('a zero-VAT note onto a MIXED invoice counts in the invoice\'s mix; the linked remainder clears it exactly', async () => {
      const y = await typedInvoice('2026-11-04', 0, [
        { description: 'Standard', quantity: 1, unitPrice: 1000, vatType: 'standard' },
        { description: 'Zero', quantity: 1, unitPrice: 300, vatType: 'zero_rated' },
        { description: 'Exempt', quantity: 1, unitPrice: 200, vatType: 'exempt' },
      ]);
      expect(await state(y)).toEqual({ remainingNet: 1500, remainingVat: 150 });
      const u = await approvedNote('2026-11-04', 100, undefined, { taxRate: 0 });   // 100 + 0
      await apply(u.id, y);
      // 100 of 1650 gross: VAT 100 x 150 / 1650 = 9.0909 -> 9.09, net 90.91.
      expect(await state(y)).toEqual({ remainingNet: 1409.09, remainingVat: 140.91 });
      const l = data<{ id: string; taxAmount: number }>(await post(creditNotesRoute, '/api/accounting/credit-notes', {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: y, creditDate: '2026-11-04', subtotal: 1409.09 }));
      expect(l.taxAmount).toBe(140.91);
      const ok = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'approve', creditNoteId: l.id, autoApply: 'none' });
      expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    });

    it('23 applications of 0.05 to a 1.00 / 0.15 invoice count exactly 1.00 / 0.15 (rounded once, on their sum)', async () => {
      const y = await typedInvoice('2026-11-05', 1);
      expect(await state(y)).toEqual({ remainingNet: 1, remainingVat: 0.15 });
      for (let i = 0; i < 23; i++) {
        const u = await approvedNote('2026-11-05', 0.04);       // 0.04 + 0.01
        await apply(u.id, y);
      }
      expect(await sql`SELECT amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id = ${y}::UUID`).toEqual([{ paid: 1.15 }]);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
    }, 60_000);
  });

  describe('LOW A: an application past the invoice\'s remaining gross is refused before any write', () => {
    /** Y 100 + 15 with a linked 50 + 7.50 approved and NOT applied: 115 outstanding, 57.50 left to credit. */
    const overCredited = async (date: string) => {
      const y = await typedInvoice(date);
      const l = await approvedNote(date, 50, y);
      expect(l.taxAmount).toBe(7.5);
      expect(await state(y)).toEqual({ remainingNet: 50, remainingVat: 7.5 });
      return y;
    };
    const written = async (y: string) => ((await sql`
      SELECT (SELECT COUNT(*)::INT FROM credit_note_allocations WHERE company_id = ${f.fx.companyId}::UUID AND invoice_id = ${y}::UUID) AS rows,
             (SELECT amount_paid::FLOAT8 FROM customer_invoices WHERE id = ${y}::UUID) AS paid`) as Record<string, number>[])[0]!;

    it('REST apply (no amount) takes the 57.50 left, not the 115 outstanding (round 5 L1); a second note is refused before any write', async () => {
      const y = await overCredited('2026-11-06');
      const u = await approvedNote('2026-11-06', 200);
      await apply(u.id, y);
      expect(await sql`SELECT amount_allocated::FLOAT8 AS a FROM credit_note_allocations WHERE credit_note_id = ${u.id}::UUID`).toEqual([{ a: 57.5 }]);
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      const v = await approvedNote('2026-11-06', 20);
      const before = await written(y);
      const r = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId: v.id, invoiceId: y });
      expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
      expect(errorOf(r)?.details?.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
      expect(errorOf(r)?.message).toMatch(/^Credit note \S+ cannot apply 23\.00 more to invoice \S+: it has nothing left to credit; /);
      expect(await written(y)).toEqual(before);
      expect(await sql`SELECT applied_amount::FLOAT8 AS a FROM credit_notes WHERE id = ${v.id}::UUID`).toEqual([{ a: 0 }]);
    });

    it('MCP apply_credit_note: a named amount past it refused live and in its dry run (true message); no amount takes what fits; adjust past it refused', async () => {
      const y = await overCredited('2026-11-07');
      const u = await approvedNote('2026-11-07', 200);
      const args = { credit_note_id: u.id, invoice_id: y, amount: 115, idempotency_key: crypto.randomUUID() };
      const before = await written(y);
      const dry = await inTx(f.fx, () => applyCreditNoteTool.handler({ ...args, dry_run: true }, ctx()));
      expect(dry.isError).toBe(true);
      expect(dry.content[0]!.text).toMatch(/cannot apply 115\.00 more to invoice \S+: it has 57\.50 left to credit \(50\.00 net and 7\.50 VAT\); .* Apply 57\.50 at most/);
      const live = await inTx(f.fx, () => applyCreditNoteTool.handler(args, ctx()));
      expect([live.isError, live.content[0]!.text]).toEqual([true, dry.content[0]!.text]);
      expect(await written(y)).toEqual(before);

      const dryFit = J(await inTx(f.fx, () => applyCreditNoteTool.handler({ credit_note_id: u.id, invoice_id: y, dry_run: true, idempotency_key: crypto.randomUUID() }, ctx())));
      const fits = J(await inTx(f.fx, () => applyCreditNoteTool.handler({ credit_note_id: u.id, invoice_id: y, idempotency_key: crypto.randomUUID() }, ctx())));
      expect(fits.amount_applied).toBe(57.5);
      expect(JSON.stringify(dryFit)).toContain('57.5');
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      const adjust = await inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
        { credit_note_id: u.id, document_id: y, new_amount: 100, idempotency_key: crypto.randomUUID() }, ctx()));
      expect(adjust.isError).toBe(true);
      expect(adjust.content[0]!.text).toMatch(/cannot apply 42\.50 more to invoice \S+: it has nothing left to credit/);
      // Down is always allowed: it gives credit back.
      const down = await inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
        { credit_note_id: u.id, document_id: y, new_amount: 20, idempotency_key: crypto.randomUUID() }, ctx()));
      expect(down.isError, down.content[0]!.text).toBeFalsy();
      expect(await state(y)).toEqual({ remainingNet: 32.61, remainingVat: 4.89 });
      // Up again within what is left now (37.50, this row's 20 counted): 57.50 fits exactly, 57.51 does not.
      const over = await inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
        { credit_note_id: u.id, document_id: y, new_amount: 57.51, idempotency_key: crypto.randomUUID() }, ctx()));
      expect(over.content[0]!.text).toMatch(/cannot apply 37\.51 more to invoice \S+: it has 37\.50 left to credit/);
      const up = await inTx(f.fx, () => adjustCreditNoteApplicationTool.handler(
        { credit_note_id: u.id, document_id: y, new_amount: 57.5, idempotency_key: crypto.randomUUID() }, ctx()));
      expect(up.isError, up.content[0]!.text).toBeFalsy();
    });

    it('approve\'s FIFO walk takes nothing to the typed invoice with nothing left and takes the credit to the next one', async () => {
      const other = (await pool.query(`INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`,
        [f.fx.companyId, `FIFO ${f.fx.tag}`])).rows[0].id as string;
      const y = await typedInvoice('2026-11-08', 100, undefined, other);
      await approvedNote('2026-11-08', 100, y, { clientId: other });   // linked 100 + 15, NOT applied: Y has 0 left, 115 outstanding
      expect(await state(y)).toEqual({ remainingNet: 0, remainingVat: 0 });
      const z = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        clientId: other, invoiceDate: '2026-11-09', taxRate: 15, items: [{ description: 'Legacy', quantity: 1, unitPrice: 100 }],
      }))).id;
      await untypeLines(z);
      await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, z, f.fx.userId));
      const u = await approvedNote('2026-11-10', 100, undefined, { clientId: other, fifo: true });
      expect(await sql`SELECT invoice_id, amount_allocated::FLOAT8 AS amount FROM credit_note_allocations WHERE credit_note_id = ${u.id}::UUID`)
        .toEqual([{ invoice_id: z, amount: 115 }]);
      expect(await sql`SELECT amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id = ${y}::UUID`).toEqual([{ paid: 0 }]);
    });
  });

  describe('LOW C: the 33.30 cent edge through invoiceCreditBasis', () => {
    it('an unlinked 33.30 + 5.00 note applied to a 100 / 15 typed invoice leaves 66.70 / 10.00', async () => {
      const y = await typedInvoice('2026-10-30');
      const u = await approvedNote('2026-10-30', 33.3);
      expect([u.taxAmount, u.totalAmount]).toEqual([5, 38.3]);
      await apply(u.id, y);
      expect(await state(y)).toEqual({ remainingNet: 66.7, remainingVat: 10 });
      const l = data<{ taxAmount: number }>(await post(creditNotesRoute, '/api/accounting/credit-notes', {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: y, creditDate: '2026-10-30', subtotal: 66.7 }));
      expect(l.taxAmount).toBe(10);
    });
  });
});
