/**
 * #1701 review round 4, against a real database:
 * - HIGH: a note applied to a typed invoice Y counts against Y whatever it is linked to, except a note linked to Y
 *   itself, which counts once through its link. Applying an unlinked note to legacy Z links it to Z (COALESCE); its
 *   earlier application to Y stopped counting on Y, so Y could be credited twice. Both orders, and a note linked at
 *   creation to X whose leftover is applied to Y.
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
const typedInvoice = async (date: string, unitPrice = 100) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, items: [{ description: 'Standard', quantity: 1, unitPrice, vatType: 'standard' }] as never,
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
const approvedNote = async (date: string, subtotal: number, linkedTo?: string) => {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, creditDate: date, subtotal, taxRate: 15, ...(linkedTo ? { customerInvoiceId: linkedTo } : {}),
  }, f.fx.userId));
  await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId, { autoApply: 'none' }));
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
