/**
 * #1701 review round 1, against a real database:
 * - item 16: the per-line VAT defaults read only the company's own rows. Company B's item (vat_on_sales exempt) on
 *   company A's preview gives no opinion (the line stays standard); create refuses B's item and B's customer before any
 *   write; the reads themselves (invoiceVatParties / resolveInvoiceVat) return nothing of B's.
 * - item 18: a typed invoice with coded lines (account, job, CC2) and mixed types, made by create (not typeLines),
 *   approves into one revenue leg per (account, job, CC2, type) and one VAT leg per rated type; a proportional credit
 *   note with no VAT given records its allocation per leg; a mixed-type draft round-trips through the real PUT.
 * - item 19/20: the preview prices a non-vendor, mixed and inclusive body as create stores it; a preview refusal is a
 *   400 with its code; an edit that changes the customer gives a NEW line the new customer's default.
 * - item 3: create_credit_note replayed by external_ref after its approval returns it (already_existed, no
 *   payload_differs), for a full and a partial credit.
 * - item 7 (as decided in round 2): an unlinked approved note applied late to a typed invoice is applied but NOT linked;
 *   since round 3 (M1) its application counts against the invoice's remaining net and VAT, and a later linked note
 *   defaults on what is left and approves; a legacy invoice links.
 * - round 2: the create_credit_note replay compares the subtotal; sibling draft notes on one typed invoice (approve exact).
 * - item 8: bulk_approve_credit_notes' dry run skips the note the live run would refuse, judged in the live order.
 * - item 17/21: the MCP tools through the registry: stored amounts_are and rows; a bulk whose second element is
 *   refused leaves nothing of the first.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import invoicePdfPreview from '../../pages/api/accounting/invoice-pdf-preview';
import creditNotesRoute from '../../pages/api/accounting/credit-notes';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { approveCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteApplyToInvoice';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { PROPORTIONAL, RECREATE } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import { buildInvoicePreviewModel } from '@/modules/accounting/services/ar/invoicePreviewModel';
import { parsePreviewBody } from '@/modules/accounting/services/ar/invoicePreviewBody';
import { invoiceVatParties, resolveInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatDefaults';
import { linesFromStoredItems, vatAtLoad, type InvoiceDetail } from '@/components/accounting/customer-invoices/editInvoiceLoad';
import { invoicePutBody } from '@/components/accounting/customer-invoices/invoicePutBody';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';
import { bulkApproveCreditNotesTool } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';
import { createDraftInvoiceTool } from '@/lib/mcp/tools/writeInvoices';
import { bulkCreateCustomerInvoicesTool } from '@/lib/mcp/tools/writeBulkCustomerInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { untypeLines } from './helpers/lineVatFixture';
import { callRoute, createUser } from './r035-approval.helpers';
import { mcpRun } from './audit-snapshots-mcp.helpers';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';
let itemB = '';
let exemptCustomer = '';

type Res = Awaited<ReturnType<typeof callRoute>>;
const data = <T>(r: Res) => (r.state.body as { data: T }).data;
const codeOf = (r: Res) => (r.state.body as { error?: { details?: { code?: string } } }).error?.details?.code;
const ctx = (): McpToolContext => ({ companyId: f.fx.companyId, userId: f.fx.userId, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'],
  companyRole: 'owner', oauthAppId: null }) as unknown as McpToolContext;
const J = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const count = async (company: string) => Number(((await sql`SELECT COUNT(*) AS n FROM customer_invoices WHERE company_id = ${company}::UUID`) as { n: string }[])[0]!.n);
const rows = async (id: string) => (await sql`
  SELECT description, unit_price::FLOAT8 AS price, amount::FLOAT8 AS amount, tax_amount::FLOAT8 AS tax, tax_rate::FLOAT8 AS rate, vat_type
  FROM customer_invoice_items WHERE invoice_id = ${id}::UUID ORDER BY line_position`) as Record<string, unknown>[];
const headerOf = async (id: string) => ((await sql`
  SELECT subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax, total_amount::FLOAT8 AS total, tax_rate::FLOAT8 AS rate, amounts_are
  FROM customer_invoices WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
const legs = async (je: string) => (await sql`
  SELECT a.account_code AS code, jl.debit::FLOAT8 AS debit, jl.credit::FLOAT8 AS credit, jl.project_id IS NOT NULL AS job,
         jl.cc2_id IS NOT NULL AS cc2, jl.vat_type AS vat
  FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
  WHERE jl.journal_entry_id = ${je}::UUID ORDER BY a.account_code, jl.vat_type NULLS FIRST, jl.debit, jl.credit`) as Record<string, unknown>[];
const approvedInvoice = async (date: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, items: items as never, ...extra,
  }))).id;
  const je = (await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId))).glJournalEntryId!;
  return { id, je };
};
const MIXED = () => [
  { description: 'Standard', quantity: 1, unitPrice: 1000, vatType: 'standard' },
  { description: 'Zero', quantity: 1, unitPrice: 300, vatType: 'zero_rated' },
  { description: 'Exempt', quantity: 1, unitPrice: 200, vatType: 'exempt' },
];

describeIfDisposable('per-line VAT writers, review round 1', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [c, user, 'owner']);
    }
    itemB = (await pool.query(`INSERT INTO items (company_id, code, description, vat_on_sales) VALUES ($1, 'B-EX', 'B exempt item', 'exempt') RETURNING id`,
      [f.other.companyId])).rows[0].id;
    await pool.query("UPDATE customers SET default_vat_type = 'exempt' WHERE id = $1", [f.other.customerId]);
    exemptCustomer = (await pool.query(`INSERT INTO customers (company_id, name, default_vat_type) VALUES ($1, $2, 'exempt') RETURNING id`,
      [f.fx.companyId, `Exempt ${f.fx.tag}`])).rows[0].id;
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await sql`DELETE FROM credit_note_revenue_allocations WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM mcp_tool_calls WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM items WHERE company_id = ${c}::UUID`;
    }
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await dropLineRevenue(f);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  describe('item 16: the defaults read only the company\'s own rows', () => {
    it('company B\'s item on company A\'s preview is refused, as create refuses it (round 2: the preview runs create\'s item refusal)', async () => {
      const err = await inTx(f.fx, () => buildInvoicePreviewModel(f.fx.companyId, parsePreviewBody({
        clientId: f.fx.customerId, invoiceDate: '2026-07-10', items: [{ description: 'A', quantity: 1, unitPrice: 100, itemId: itemB }],
      }))).catch((e: unknown) => e);
      expect([(err as { code?: string }).code, (err as Error).message]).toEqual(['ITEM_LINE_REFUSED', 'items[0].item_id is not an item of your company']);
    });

    it('the reads: B\'s customer default and B\'s item are not A\'s', async () => {
      expect(await inTx(f.fx, () => invoiceVatParties(f.fx.companyId, f.other.customerId))).toEqual({ registered: true, customerVat: null });
      expect(await inTx(f.fx, () => resolveInvoiceVat(f.fx.companyId, f.other.customerId, {
        invoiceDate: '2026-07-10', headerTaxRate: undefined, lines: [{ itemId: itemB }],
      }))).toEqual({ typed: true, types: ['standard'] });
    });

    it('create refuses B\'s item and B\'s customer before any write', async () => {
      const n = await count(f.fx.companyId);
      const byItem = await callRoute(customerInvoicesCreate, tokens[user]!, f.fx.companyId, 'POST', {
        clientId: f.fx.customerId, invoiceDate: '2026-07-10', items: [{ description: 'A', quantity: 1, unitPrice: 100, itemId: itemB }],
      }, '/api/accounting/customer-invoices-create');
      expect([byItem.state.statusCode, codeOf(byItem)]).toEqual([400, 'ITEM_LINE_REFUSED']);
      const byCustomer = await callRoute(customerInvoicesCreate, tokens[user]!, f.fx.companyId, 'POST', {
        clientId: f.other.customerId, invoiceDate: '2026-07-10', items: [{ description: 'A', quantity: 1, unitPrice: 100 }],
      }, '/api/accounting/customer-invoices-create');
      expect(byCustomer.state.statusCode).toBe(400);
      expect(await count(f.fx.companyId)).toBe(n);
    });
  });

  describe('item 18: coded, mixed, typed: create -> approve -> credit note', () => {
    it('one revenue leg per (account, job, CC2, type), a VAT leg per rated type, and a proportional note\'s allocation per leg', async () => {
      const { id, je } = await approvedInvoice('2026-07-15', [
        { description: 'Spot', quantity: 1, unitPrice: 1000, vatType: 'standard', glAccountId: f.acct.commercials, projectId: f.project.p1 },
        { description: 'Edit', quantity: 1, unitPrice: 400, vatType: 'standard', glAccountId: f.acct.postProduction, cc2Id: f.dim.cc2 },
        { description: 'Export', quantity: 1, unitPrice: 300, vatType: 'zero_rated', glAccountId: f.acct.commercials, projectId: f.project.p1 },
        { description: 'Rent', quantity: 1, unitPrice: 300, vatType: 'exempt' },
      ]);
      expect(await rows(id)).toEqual([
        { description: 'Spot', price: 1000, amount: 1000, tax: 150, rate: 15, vat_type: 'standard' },
        { description: 'Edit', price: 400, amount: 400, tax: 60, rate: 15, vat_type: 'standard' },
        { description: 'Export', price: 300, amount: 300, tax: 0, rate: 0, vat_type: 'zero_rated' },
        { description: 'Rent', price: 300, amount: 300, tax: 0, rate: 0, vat_type: 'exempt' },
      ]);
      expect(await legs(je)).toEqual([
        { code: '1100', debit: 2210, credit: 0, job: false, cc2: false, vat: null },
        { code: '2120', debit: 0, credit: 210, job: false, cc2: false, vat: 'standard' },
        { code: '4000', debit: 0, credit: 300, job: false, cc2: false, vat: 'exempt' },
        { code: '4100', debit: 0, credit: 1000, job: true, cc2: false, vat: 'standard' },
        { code: '4100', debit: 0, credit: 300, job: true, cc2: false, vat: 'zero_rated' },
        { code: '4200', debit: 0, credit: 400, job: false, cc2: true, vat: 'standard' },
      ]);

      // A note for 200 of the 2000 net with no VAT given: a tenth of every leg, VAT a tenth of the 210 left.
      const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-07-20', subtotal: 200,
      }, f.fx.userId));
      expect([cn.taxAmount, cn.taxRate]).toEqual([21, 15]);
      const approved = await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId));
      expect(await legs(approved.glJournalEntryId!)).toEqual([
        { code: '1100', debit: 0, credit: 221, job: false, cc2: false, vat: null },
        { code: '2120', debit: 21, credit: 0, job: false, cc2: false, vat: 'standard' },
        { code: '4000', debit: 30, credit: 0, job: false, cc2: false, vat: 'exempt' },
        { code: '4100', debit: 100, credit: 0, job: true, cc2: false, vat: 'standard' },
        { code: '4100', debit: 30, credit: 0, job: true, cc2: false, vat: 'zero_rated' },
        { code: '4200', debit: 40, credit: 0, job: false, cc2: true, vat: 'standard' },
      ]);
      expect((await sql`SELECT amount::FLOAT8 AS amount, is_excess FROM credit_note_revenue_allocations
        WHERE credit_note_id = ${cn.id}::UUID ORDER BY amount`)).toEqual([
        { amount: 30, is_excess: false }, { amount: 30, is_excess: false }, { amount: 40, is_excess: false }, { amount: 100, is_excess: false },
      ]);
    });

    it('a mixed-type coded draft round-trips through the real PUT with the edit page\'s own body', async () => {
      const made = await callRoute(customerInvoicesCreate, tokens[user]!, f.fx.companyId, 'POST', {
        clientId: f.fx.customerId, invoiceDate: '2026-07-16', items: MIXED().map((l, i) => (i === 0 ? { ...l, glAccountId: f.acct.commercials } : l)),
      }, '/api/accounting/customer-invoices-create');
      const id = data<{ id: string }>(made).id;
      const before = { rows: await rows(id), header: await headerOf(id) };
      const d = data<InvoiceDetail & { draft_digest: string }>(await callRoute(customerInvoicesDetail, tokens[user]!, f.fx.companyId, 'GET', undefined,
        '/api/accounting/customer-invoices-detail', { id }));
      const v = vatAtLoad(d);
      const lines = linesFromStoredItems(d.items ?? [], '', v);
      const form = { clientId: f.fx.customerId, invoiceDate: d.invoice_date, dueDate: '', billingPeriodStart: '', billingPeriodEnd: '',
        taxRate: v.formRate, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
      const body = invoicePutBody(id, { form, lines, taxMode: v.mode }, { omitDueDate: true });
      expect(body.items.map((i) => i.vatType)).toEqual(['standard', 'zero_rated', 'exempt']);
      const put = await callRoute(customerInvoicesDetail, tokens[user]!, f.fx.companyId, 'PUT', { ...body, expectedDraftDigest: d.draft_digest },
        '/api/accounting/customer-invoices-detail');
      expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
      expect({ rows: await rows(id), header: await headerOf(id) }).toEqual(before);
    });
  });

  describe('items 19 / 20: preview parity and the edit\'s customer', () => {
    it.each([
      ['mixed', { items: MIXED() }],
      ['inclusive', { amountsAre: 'inclusive', items: [{ description: 'Ten', quantity: 100, unitPrice: 9.99, vatType: 'standard' }, MIXED()[2]] }],
    ])('the preview of a %s body prints what create stores', async (_l, payload) => {
      const body = { clientId: f.fx.customerId, invoiceDate: '2026-07-17', ...payload };
      const p = (await inTx(f.fx, () => buildInvoicePreviewModel(f.fx.companyId, parsePreviewBody(JSON.parse(JSON.stringify(body))))))!;
      const made = await callRoute(customerInvoicesCreate, tokens[user]!, f.fx.companyId, 'POST', body, '/api/accounting/customer-invoices-create');
      const id = data<{ id: string }>(made).id;
      const h = await headerOf(id);
      expect([p.model.invoice.subtotal, p.model.invoice.tax_amount, p.model.invoice.total_amount, p.model.invoice.amounts_are])
        .toEqual([h.subtotal, h.tax, h.total, h.amounts_are]);
      expect(p.model.items.map((i) => [i.amount, i.tax_amount, i.vat_type])).toEqual((await rows(id)).map((r) => [r.amount, r.tax, r.vat_type]));
    });

    it('a non-vendor\'s preview prints what create stores: no VAT, untyped, exclusive', async () => {
      await pool.query("UPDATE companies SET vat_system_type = 'none', vat_period = 'none' WHERE id = $1", [f.other.companyId]);
      await pool.query("UPDATE customers SET default_vat_type = NULL WHERE id = $1", [f.other.customerId]);
      try {
        const body = { clientId: f.other.customerId, invoiceDate: '2026-07-17', amountsAre: 'inclusive', items: [{ description: 'S', quantity: 2, unitPrice: 57.5 }] };
        const p = (await inTx(f.other, () => buildInvoicePreviewModel(f.other.companyId, parsePreviewBody(body))))!;
        const made = await callRoute(customerInvoicesCreate, tokens[user]!, f.other.companyId, 'POST', body, '/api/accounting/customer-invoices-create');
        const id = data<{ id: string }>(made).id;
        expect(await headerOf(id)).toEqual({ subtotal: 115, tax: 0, total: 115, rate: 0, amounts_are: 'exclusive' });
        expect([p.model.invoice.subtotal, p.model.invoice.tax_amount, p.model.invoice.amounts_are, p.model.items[0]!.vat_type]).toEqual([115, 0, 'exclusive', null]);
      } finally {
        await pool.query('UPDATE companies SET vat_system_type = NULL, vat_period = NULL WHERE id = $1', [f.other.companyId]);
      }
    });

    it('a preview refusal is a 400 with its code', async () => {
      const r = await callRoute(invoicePdfPreview, tokens[user]!, f.fx.companyId, 'POST', {
        clientId: f.fx.customerId, invoiceDate: '2026-07-17', taxRate: 14, items: [{ description: 'A', quantity: 1, unitPrice: 1 }],
      }, '/api/accounting/invoice-pdf-preview');
      expect([r.state.statusCode, codeOf(r)]).toEqual([400, 'INVOICE_LINE_VAT_REFUSED']);
    });

    it('an edit that moves the invoice to an exempt customer: a NEW line is exempt, the kept line keeps its type', async () => {
      const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        clientId: f.fx.customerId, invoiceDate: '2026-07-18', items: [{ description: 'Kept', quantity: 1, unitPrice: 100 }],
      }))).id;
      const put = await callRoute(customerInvoicesDetail, tokens[user]!, f.fx.companyId, 'PUT', { id, clientId: exemptCustomer,
        items: [{ description: 'Kept', quantity: 1, unitPrice: 100 }, { description: 'New', quantity: 1, unitPrice: 50 }] },
      '/api/accounting/customer-invoices-detail');
      expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
      expect((await rows(id)).map((r) => [r.description, r.vat_type])).toEqual([['Kept', 'standard'], ['New', 'exempt']]);
    });
  });

  describe('item 3: create_credit_note replayed after its approval', () => {
    it.each([['the full remainder', 1500], ['a partial credit', 150]])('%s: already_existed, the payload not reported as differing', async (_l, subtotal) => {
      const { id } = await approvedInvoice('2026-08-10', MIXED());
      const args = { type: 'customer', client_id: f.fx.customerId, customer_invoice_id: id, credit_date: '2026-08-20', subtotal,
        external_system: 'sage', external_ref: `CRET-${subtotal}-${id.slice(0, 8)}`, idempotency_key: crypto.randomUUID() };
      const made = J(await inTx(f.fx, () => createCreditNoteTool.handler(args, ctx())));
      expect(made.tax_amount).toBe(subtotal / 10);
      await inTx(f.fx, () => approveCreditNote(f.fx.companyId, String(made.id), f.fx.userId));
      const replay = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect(replay).toMatchObject({ already_existed: true, payload_differs: false, id: made.id });
    });
  });

  describe('item 7: a late link to a typed invoice', () => {
    const unlinkedApprovedNote = async () => {
      const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, creditDate: '2026-09-20', subtotal: 100, taxRate: 15,
      }, f.fx.userId));
      await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId, { autoApply: 'none' }));
      return cn.id;
    };

    it('round 2: applied but NOT linked; rounds 3-4: its application counts (in the invoice\'s proportion), a later linked note defaults on what is left; a legacy invoice links', async () => {
      const typed = await approvedInvoice('2026-09-10', MIXED());
      const before = await inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, typed.id));
      expect(before).toEqual({ remainingNet: 1500, remainingVat: 150 });
      const noteId = await unlinkedApprovedNote();
      const applied = await inTx(f.fx, () => applyCreditNoteToInvoice(f.fx.companyId, noteId, typed.id, f.fx.userId));
      expect(applied.customerInvoiceId).toBeUndefined();
      expect(await sql`SELECT customer_invoice_id, applied_amount::FLOAT8 AS applied FROM credit_notes WHERE id = ${noteId}::UUID`)
        .toEqual([{ customer_invoice_id: null, applied: 115 }]);
      expect(await sql`SELECT amount_paid::FLOAT8 AS paid FROM customer_invoices WHERE id = ${typed.id}::UUID`).toEqual([{ paid: 115 }]);
      expect(await sql`SELECT amount_allocated::FLOAT8 AS amount FROM credit_note_allocations WHERE credit_note_id = ${noteId}::UUID AND invoice_id = ${typed.id}::UUID`)
        .toEqual([{ amount: 115 }]);
      expect(await sql`SELECT COUNT(*)::INT AS n FROM credit_note_revenue_allocations WHERE credit_note_id = ${noteId}::UUID`).toEqual([{ n: 0 }]);
      // Rounds 3-4: the 115 applied uses the invoice's gross capacity in ITS proportion (1500 : 150): VAT 115 x 150 / 1650 = 10.45.
      expect(await inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, typed.id))).toEqual({ remainingNet: 1395.45, remainingVat: 139.55 });

      const later = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: typed.id, creditDate: '2026-09-21', subtotal: 150,
      }, f.fx.userId));
      expect(later.taxAmount).toBe(15); // 139.55 x 150 / 1395.45 = 15.0005
      await inTx(f.fx, () => approveCreditNote(f.fx.companyId, later.id, f.fx.userId));
      expect(await inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, typed.id))).toEqual({ remainingNet: 1245.45, remainingVat: 124.55 });

      const legacyId = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        clientId: f.fx.customerId, invoiceDate: '2026-09-11', taxRate: 15, items: [{ description: 'L', quantity: 1, unitPrice: 1000 }],
      }))).id;
      await untypeLines(legacyId);
      await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, legacyId, f.fx.userId));
      const second = await unlinkedApprovedNote();
      expect((await inTx(f.fx, () => applyCreditNoteToInvoice(f.fx.companyId, second, legacyId, f.fx.userId))).customerInvoiceId).toBe(legacyId);
    });
  });

  describe('golden path (e) through the REST routes, against the TYPED invoice create now makes', () => {
    it('invoice 200 at 15% -> unlinked note 100 + 15 -> approve (autoApply none) -> apply: 200 OK, the note unlinked, 115 applied', async () => {
      const post = (route: Parameters<typeof callRoute>[0], url: string, body: Record<string, unknown>) =>
        callRoute(route, tokens[user]!, f.fx.companyId, 'POST', body, url);
      const made = await post(customerInvoicesCreate, '/api/accounting/customer-invoices-create', {
        clientId: f.fx.customerId, invoiceDate: '2026-12-15', dueDate: '2026-12-15', taxRate: 15, notes: 'GP-E',
        items: [{ description: 'GP-E', quantity: 1, unitPrice: 200 }] });
      const invoiceId = data<{ id: string }>(made).id;
      expect((await rows(invoiceId)).map((r) => [r.vat_type, r.tax])).toEqual([['standard', 30]]); // typed, so the late-link path is the typed one
      const approvedInv = await post(customerInvoicesDetail, '/api/accounting/customer-invoices-detail', { id: invoiceId, action: 'approve' });
      expect(approvedInv.state.statusCode, JSON.stringify(approvedInv.state.body)).toBe(200);
      const before = await inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, invoiceId));
      expect(before).toEqual({ remainingNet: 200, remainingVat: 30 });

      const cn = data<{ id: string; taxAmount: number }>(await post(creditNotesRoute, '/api/accounting/credit-notes', {
        type: 'customer', clientId: f.fx.customerId, creditDate: '2026-12-15', reason: 'GP-E CN', subtotal: 100, taxRate: 15 }));
      expect(cn.taxAmount).toBe(15);
      const approved = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'approve', creditNoteId: cn.id, autoApply: 'none' });
      expect(approved.state.statusCode, JSON.stringify(approved.state.body)).toBe(200);
      expect(data<{ status: string; applied_to_invoice_ids: unknown[] }>(approved)).toMatchObject({ status: 'approved', applied_to_invoice_ids: [] });

      const applied = await post(creditNotesAction, '/api/accounting/credit-notes-action', { action: 'apply', creditNoteId: cn.id, invoiceId });
      expect(applied.state.statusCode, JSON.stringify(applied.state.body)).toBe(200);
      expect(data<{ applied_to_invoice_ids: unknown[] }>(applied).applied_to_invoice_ids).toEqual([{ invoice_id: invoiceId, amount: 115 }]);
      expect(await sql`SELECT customer_invoice_id, applied_amount::FLOAT8 AS applied, status FROM credit_notes WHERE id = ${cn.id}::UUID`)
        .toEqual([{ customer_invoice_id: null, applied: 115, status: 'applied' }]);
      expect(await sql`SELECT total_amount::FLOAT8 - amount_paid::FLOAT8 AS balance FROM customer_invoices WHERE id = ${invoiceId}::UUID`)
        .toEqual([{ balance: 115 }]);
      // Round 3 M1: the 115 applied counts against the invoice, 100 net and 15 VAT.
      expect(await inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, invoiceId))).toEqual({ remainingNet: 100, remainingVat: 15 });
    });
  });

  describe('round 2 item 2: create_credit_note replay compares the subtotal', () => {
    it('a legacy-invoice note replayed with another subtotal reports payload_differs', async () => {
      const legacyId = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
        clientId: f.fx.customerId, invoiceDate: '2026-08-12', taxRate: 15, items: [{ description: 'L', quantity: 1, unitPrice: 1000 }],
      }))).id;
      await untypeLines(legacyId);
      await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, legacyId, f.fx.userId));
      const args = { type: 'customer', client_id: f.fx.customerId, customer_invoice_id: legacyId, credit_date: '2026-08-22', subtotal: 100,
        external_system: 'sage', external_ref: `CRET-L-${legacyId.slice(0, 8)}`, idempotency_key: crypto.randomUUID() };
      const made = J(await inTx(f.fx, () => createCreditNoteTool.handler(args, ctx())));
      expect([made.subtotal, made.tax_amount]).toEqual([100, 15]);
      const same = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, idempotency_key: crypto.randomUUID() }, ctx())));
      expect(same).toMatchObject({ already_existed: true, payload_differs: false, id: made.id });
      const other = J(await inTx(f.fx, () => createCreditNoteTool.handler({ ...args, subtotal: 500, idempotency_key: crypto.randomUUID() }, ctx())));
      expect(other).toMatchObject({ already_existed: true, payload_differs: true, id: made.id,
        differences: [{ field: 'subtotal', existing: 100, requested: 500 }] });
    });
  });

  describe('round 2 item 4: sibling DRAFT notes against one typed invoice (approve stays exact)', () => {
    it('100.00 / 15.00: drafts of 48.10 and 48.13 both carry 7.22; after the first approves the second needs 7.21, refused naming it; recreated, it approves', async () => {
      const { id } = await approvedInvoice('2026-12-10', [{ description: 'Std', quantity: 1, unitPrice: 100, vatType: 'standard' }]);
      const draft = (subtotal: number) => inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-12-20', subtotal,
      }, f.fx.userId));
      const a = await draft(48.1);
      const b = await draft(48.13);
      expect([a.taxAmount, b.taxAmount]).toEqual([7.22, 7.22]);
      await inTx(f.fx, () => approveCreditNote(f.fx.companyId, a.id, f.fx.userId));
      const err = await inTx(f.fx, () => approveCreditNote(f.fx.companyId, b.id, f.fx.userId)).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
      expect((err as Error).message).toBe(`Credit note ${b.creditNoteNumber} reverses 48.13 of an invoice with 51.90 left, so its VAT must be 7.21, `
        + `not 7.22. ${PROPORTIONAL} ${RECREATE}`);
      await inTx(f.fx, () => cancelDraftCreditNote(f.fx.companyId, b.id, user, 'stale VAT')); // a users row: the audit row FKs it
      const again = await draft(48.13);
      expect(again.taxAmount).toBe(7.21);
      await inTx(f.fx, () => approveCreditNote(f.fx.companyId, again.id, f.fx.userId));
      expect(await inTx(f.fx, () => typedInvoiceCreditState(f.fx.companyId, id))).toEqual({ remainingNet: 3.77, remainingVat: 0.57 });
    });
  });

  describe('item 8: bulk_approve_credit_notes dry run, judged in the live order', () => {
    it('a note the live run would refuse is skipped, not in would_post_ids; the ones it would post are', async () => {
      const { id } = await approvedInvoice('2026-10-10', MIXED());
      const draft = (subtotal: number, taxAmount: number) => inTx(f.fx, () => createCreditNote(f.fx.companyId, {
        type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-10-20', subtotal, taxAmount,
      }, f.fx.userId));
      const good = [await draft(150, 15), await draft(150, 15)];
      const bad = await draft(150, 22.5);
      const ids = [...good, bad].map((n) => n.id);
      const preview = J(await inTx(f.fx, () => bulkApproveCreditNotesTool.handler({ credit_note_ids: ids, dry_run: true, idempotency_key: 'k' }, ctx())));
      expect([...(preview.would_post_ids as string[])].sort()).toEqual(good.map((n) => n.id).sort());
      expect((preview.skipped as { document_id: string; reason: string }[]).map((s) => [s.document_id, s.reason.slice(0, 17)]))
        .toEqual([[bad.id, 'vat_split_refused']]);
      const live = J(await inTx(f.fx, () => bulkApproveCreditNotesTool.handler({ credit_note_ids: ids, idempotency_key: 'k2' }, ctx())));
      expect((live.skipped as { document_id: string; reason: string }[]).map((s) => [s.document_id, s.reason.slice(0, 17)]))
        .toEqual([[bad.id, 'vat_split_refused']]);
    });
  });

  describe('items 17 / 21: the MCP tools through the registry', () => {
    const tools = [createDraftInvoiceTool, bulkCreateCustomerInvoicesTool];
    const run = (name: string, args: Record<string, unknown>) =>
      mcpRun(pool, tools, user, f.fx.companyId, 'owner', name, args, ['write:invoices']);

    it('create_draft_invoice stores amounts_are and each line\'s VAT', async () => {
      const out = await run('create_draft_invoice', { customer_id: f.fx.customerId, invoice_date: '2026-11-10', amounts_are: 'inclusive',
        items: [{ description: 'Ten', quantity: 100, unit_price: 9.99, vat_type: 'standard' }, { description: 'Rent', unit_price: 200, vat_type: 'exempt' }] });
      expect(out.isError, out.content[0]!.text).toBeFalsy();
      const id = String(J(out).id);
      expect(await headerOf(id)).toEqual({ subtotal: 1068.7, tax: 130.3, total: 1199, rate: 15, amounts_are: 'inclusive' });
      expect((await rows(id)).map((r) => [r.price, r.amount, r.tax, r.vat_type])).toEqual([[9.99, 868.7, 130.3, 'standard'], [200, 200, 0, 'exempt']]);
    });

    it('bulk: element 2 refused, nothing of element 1 persists', async () => {
      const n = await count(f.fx.companyId);
      const out = await run('bulk_create_customer_invoices', { invoices: [
        { customer_id: f.fx.customerId, invoice_date: '2026-11-11', items: [{ description: 'OK', unit_price: 100 }] },
        { customer_id: f.fx.customerId, invoice_date: '2026-11-11', tax_rate: 14, items: [{ description: 'Bad', unit_price: 100 }] },
      ] });
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/^invoices\[1\]: taxRate 14 is neither the VAT rate/);
      expect(await count(f.fx.companyId)).toBe(n);
    });
  });
});
