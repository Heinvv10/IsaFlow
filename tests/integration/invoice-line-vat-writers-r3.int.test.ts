/**
 * #1701 review round 3, against a real database:
 * - M1: an UNLINKED approved note applied to a TYPED invoice counts against it. Invoice A 100 + 15; note U 50 + 7.50,
 *   approved unlinked and applied to A through the REST apply (applied, not linked: round 2). A's remaining is then
 *   50 / 7.50: a linked note L of 100 is refused before any write (create without VAT, and approve of one carrying a
 *   figure), L of 50 defaults to 7.50 and approves, leaving 0 / 0. Unapply and cancel give U's share back.
 * - M2 / L2: a rate gives its VAT in exact cents everywhere: createCreditNote stores 5.00 on 33.30 at 15% (the float
 *   product stored 4.99), and create_credit_note's duplicate-draft check finds a 3.30 at 15% draft (3.80; it compared
 *   3.79, so a fresh-key retry created a second note).
 * - Q3: create_credit_note against a legacy invoice whose header rate is 0 stores rate 0 and VAT 0, and replays clean;
 *   a typed note with an explicit rate (33.30 at 15% = 5.00, the required figure) replays with payload_differs false.
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
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';
import type { McpToolContext } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { untypeLines } from './helpers/lineVatFixture';
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
const data = <T>(r: Res) => (r.state.body as { data: T }).data;
const errorOf = (r: Res) => (r.state.body as { error?: { message?: string; details?: { code?: string } } }).error;
const ctx = (): McpToolContext => ({ companyId: f.fx.companyId, userId: f.fx.userId, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'],
  companyRole: 'owner', oauthAppId: null }) as unknown as McpToolContext;
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const post = (route: Parameters<typeof callRoute>[0], url: string, body: Record<string, unknown>) =>
  callRoute(route, tokens[user]!, f.fx.companyId, 'POST', body, url);
const state = (invoiceId: string) => inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, invoiceId));
const counts = async () => ((await sql`
  SELECT (SELECT COUNT(*)::INT FROM credit_notes WHERE company_id = ${f.fx.companyId}::UUID) AS notes,
         (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID) AS journals,
         (SELECT COUNT(*)::INT FROM credit_note_revenue_allocations WHERE company_id = ${f.fx.companyId}::UUID) AS takes`) as Record<string, number>[])[0]!;
const typedInvoice = async (date: string, unitPrice = 100) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, items: [{ description: 'Standard', quantity: 1, unitPrice, vatType: 'standard' }] as never,
  }))).id;
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
};
/** U: an unlinked note, approved with nothing applied. */
const unlinkedNote = async (date: string, subtotal: number) => {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, creditDate: date, subtotal, taxRate: 15,
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId, { autoApply: 'none' }));
  return cn;
};

describeIfDisposable('per-line VAT writers, review round 3', () => {
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

  describe('M1: an unlinked note applied to a typed invoice counts against it', () => {
    it('A 100 + 15, U 50 + 7.50 applied through REST: L of 100 refused before any write; L of 50 defaults to 7.50 and approves', async () => {
      const a = await typedInvoice('2026-10-05');
      expect(await state(a)).toEqual({ remainingNet: 100, remainingVat: 15 });
      const u = await unlinkedNote('2026-10-06', 50);
      expect(u.taxAmount).toBe(7.5);
      const applied = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId: u.id, invoiceId: a });
      expect(applied.state.statusCode, JSON.stringify(applied.state.body)).toBe(200);
      expect(await sql`SELECT customer_invoice_id, applied_amount::FLOAT8 AS applied FROM credit_notes WHERE id = ${u.id}::UUID`)
        .toEqual([{ customer_invoice_id: null, applied: 57.5 }]);
      expect(await state(a)).toEqual({ remainingNet: 50, remainingVat: 7.5 });

      // Over the remainder, no VAT given: refused at create, nothing written.
      const before = await counts();
      const over = await post(creditNotesRoute, '/api/accounting/credit-notes', {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: a, creditDate: '2026-10-07', subtotal: 100 });
      expect(over.state.statusCode, JSON.stringify(over.state.body)).toBe(400);
      expect(errorOf(over)?.details?.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
      expect(errorOf(over)?.message).toMatch(/credits 100\.00, but invoice \S+ has 50\.00 left to credit/);
      expect(await counts()).toEqual(before);

      // Over the remainder WITH a figure (create does not judge a figure): approve refuses it before its journal.
      const figured = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: a, creditDate: '2026-10-07', subtotal: 100, taxAmount: 15,
      }, f.fx.userId));
      const drafted = await counts();
      await expect(inTx(f.fx, () => approveCreditNote(f.fx.companyId, figured.id, f.fx.userId)))
        .rejects.toThrow(/credits 100\.00, but the invoice has 50\.00 left to credit/);
      await expect(inTx(f.fx, () => approveCreditNote(f.fx.companyId, figured.id, f.fx.userId))).rejects.toBeInstanceOf(CreditNoteVatSplitRefusal);
      expect(await counts()).toEqual(drafted);
      expect(await sql`SELECT status FROM credit_notes WHERE id = ${figured.id}::UUID`).toEqual([{ status: 'draft' }]);
      await sql`DELETE FROM credit_notes WHERE id = ${figured.id}::UUID AND company_id = ${f.fx.companyId}::UUID`;

      // The true remainder: 50 defaults to 7.50 and approves, leaving nothing.
      const l = data<{ id: string; taxAmount: number; totalAmount: number }>(await post(creditNotesRoute, '/api/accounting/credit-notes', {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: a, creditDate: '2026-10-07', subtotal: 50 }));
      expect([l.taxAmount, l.totalAmount]).toEqual([7.5, 57.5]);
      const approved = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'approve', creditNoteId: l.id, autoApply: 'none' });
      expect(approved.state.statusCode, JSON.stringify(approved.state.body)).toBe(200);
      expect(await state(a)).toEqual({ remainingNet: 0, remainingVat: 0 });
    });

    it('a partial application counts its share by the note\'s own net : VAT; unapply and cancel give it back', async () => {
      const a = await typedInvoice('2026-10-08');
      const u = await unlinkedNote('2026-10-08', 200);   // 200 + 30, more than A's 115: the apply takes A's balance
      await inTx(f.fx, () => applyCreditNoteToInvoice(f.fx.companyId, u.id, a, f.fx.userId));
      // 115 applied of a 230 note (200 : 30): VAT 115 x 30 / 230 = 15.00, net 100.00.
      expect(await state(a)).toEqual({ remainingNet: 0, remainingVat: 0 });
      await inTx(f.fx, () => unapplyCreditNote(f.fx.companyId, { creditNoteId: u.id, invoiceId: a }, f.fx.userId));
      expect(await state(a)).toEqual({ remainingNet: 100, remainingVat: 15 });

      const b = await typedInvoice('2026-10-09');
      const v = await unlinkedNote('2026-10-09', 20);      // 20 + 3
      const applied = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId: v.id, invoiceId: b });
      expect(applied.state.statusCode, JSON.stringify(applied.state.body)).toBe(200);
      expect(await state(b)).toEqual({ remainingNet: 80, remainingVat: 12 });
      await inTx(f.fx, () => cancelCreditNote(f.fx.companyId, v.id, f.fx.userId, 'round 3'));
      expect(await state(b)).toEqual({ remainingNet: 100, remainingVat: 15 });
    });

    it('another company\'s rows never count: company B\'s note on A\'s invoice id reads nothing', async () => {
      const a = await typedInvoice('2026-10-10');
      const foreign = (await pool.query(`INSERT INTO credit_notes (company_id, credit_note_number, type, client_id, credit_date, subtotal, tax_rate,
        tax_amount, total_amount, status, created_by) VALUES ($1, $2, 'customer', $3, '2026-10-10', 50, 15, 7.5, 57.5, 'approved', $4) RETURNING id`,
      [f.other.companyId, `CN-B-${f.other.tag.slice(0, 8)}`, f.other.customerId, f.other.userId])).rows[0].id as string;
      await pool.query('INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated) VALUES ($1, $2, $3, 57.5)',
        [f.other.companyId, foreign, a]);
      expect(await state(a)).toEqual({ remainingNet: 100, remainingVat: 15 });
      await pool.query('DELETE FROM credit_note_allocations WHERE credit_note_id = $1', [foreign]);
      await pool.query('DELETE FROM credit_notes WHERE id = $1', [foreign]);
    });
  });

  describe('M2 / L2: a rate gives its VAT in exact cents', () => {
    it.each([[33.3, 5, 38.3], [3.3, 0.5, 3.8], [43.3, 6.5, 49.8], [100.3, 15.05, 115.35]])(
      'createCreditNote stores %s at 15 percent as VAT %s, total %s', async (subtotal, tax, total) => {
        const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
          type: 'customer', clientId: f.fx.customerId, creditDate: '2026-10-11', subtotal, taxRate: 15,
        }, f.fx.userId));
        expect(await sql`SELECT tax_amount::FLOAT8 AS tax, total_amount::FLOAT8 AS total FROM credit_notes WHERE id = ${cn.id}::UUID`)
          .toEqual([{ tax, total }]);
      });

    it('create_credit_note finds the identical 3.30 at 15% draft (3.80) on a fresh-key retry', async () => {
      const args = { type: 'customer', client_id: f.fx.customerId, credit_date: '2026-10-12', subtotal: 3.3, tax_rate: 15 };
      const made = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect([made.tax_amount, made.total_amount]).toEqual([0.5, 3.8]);
      const retry = await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx()));
      expect(retry.isError).toBe(true);
      expect(retry.content[0]!.text).toContain(`An identical draft credit note already exists (id ${String(made.id)})`);
    });
  });

  describe('Q3: create_credit_note without mocks', () => {
    it('linked to a legacy invoice whose header rate is 0: rate 0, VAT 0, and the replay does not differ', async () => {
      const legacy = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        clientId: f.fx.customerId, invoiceDate: '2026-10-13', taxRate: 0, items: [{ description: 'Zero', quantity: 1, unitPrice: 300 }],
      }))).id;
      await untypeLines(legacy);
      await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, legacy, f.fx.userId));
      expect(await sql`SELECT tax_rate::FLOAT8 AS rate FROM customer_invoices WHERE id = ${legacy}::UUID`).toEqual([{ rate: 0 }]);
      const args = { type: 'customer', client_id: f.fx.customerId, customer_invoice_id: legacy, credit_date: '2026-10-14', subtotal: 100,
        external_system: 'sage', external_ref: `CRET-Z-${legacy.slice(0, 8)}` };
      const made = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect([made.tax_rate, made.tax_amount, made.total_amount]).toEqual([0, 0, 100]);
      const again = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect(again).toMatchObject({ already_existed: true, payload_differs: false, id: made.id });
    });

    it('a typed note with an explicit rate (33.30 at 15% = 5.00, the required figure) replays with payload_differs false', async () => {
      const a = await typedInvoice('2026-10-15');
      const args = { type: 'customer', client_id: f.fx.customerId, customer_invoice_id: a, credit_date: '2026-10-15', subtotal: 33.3, tax_rate: 15,
        external_system: 'sage', external_ref: `CRET-T-${a.slice(0, 8)}` };
      const made = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect([made.tax_rate, made.tax_amount, made.total_amount]).toEqual([15, 5, 38.3]);
      const again = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect(again).toMatchObject({ already_existed: true, payload_differs: false, id: made.id });
    });
  });
});
