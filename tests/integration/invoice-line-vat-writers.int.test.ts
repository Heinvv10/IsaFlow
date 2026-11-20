/**
 * The per-line VAT WRITERS through the real HTTP handlers (customer-invoices-create, customer-invoices-detail PUT):
 * - inclusive: 100 x 9.99 entered VAT-inclusive stores unit_price 9.99, net 868.70, VAT 130.30, total 999.00, lines
 *   foot, it posts, and the edit page's own loader + PUT body round-trips it with nothing moved;
 * - the legacy header taxRate: the standard rate types every line standard, 0 zero_rated; 14 is refused, as is a header
 *   rate together with a line vatType, each a 400 with its code and nothing written;
 * - a company not registered for VAT: untyped lines, no VAT; a standard line refused;
 * - the draft edit keeps a stored line's type, re-taxes a date moved across 1 April 2018, and saving a LEGACY draft
 *   types it: its approval digest moves, an approval request raised on the old content no longer matches.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { ApprovalDocumentChangedError, assertDocumentUnchanged } from '@/modules/accounting/services/gl/approvalDecideDocument';
import { linesFromStoredItems, vatAtLoad, type InvoiceDetail } from '@/components/accounting/customer-invoices/editInvoiceLoad';
import { invoicePutBody } from '@/components/accounting/customer-invoices/invoicePutBody';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L, untypeLines } from './helpers/lineVatFixture';
import { callRoute, createUser } from './r035-approval.helpers';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';
const CREATE = '/api/accounting/customer-invoices-create';
const DETAIL = '/api/accounting/customer-invoices-detail';

type Res = Awaited<ReturnType<typeof callRoute>>;
const body = <T>(r: Res) => (r.state.body as { data: T }).data;
const codeOf = (r: Res) => (r.state.body as { error?: { details?: { code?: string } } }).error?.details?.code;
const create = (company: string, payload: Record<string, unknown>) =>
  callRoute(customerInvoicesCreate, tokens[user]!, company, 'POST', { clientId: f.fx.customerId, ...payload }, CREATE);
const put = (payload: Record<string, unknown>) => callRoute(customerInvoicesDetail, tokens[user]!, f.fx.companyId, 'PUT', payload, DETAIL);
const detail = async (id: string) => body<InvoiceDetail & { draft_digest: string }>(
  await callRoute(customerInvoicesDetail, tokens[user]!, f.fx.companyId, 'GET', undefined, DETAIL, { id }));
const rows = async (id: string) => (await sql`
  SELECT description, quantity::FLOAT8 AS qty, unit_price::FLOAT8 AS price, amount::FLOAT8 AS amount,
         tax_amount::FLOAT8 AS tax, tax_rate::FLOAT8 AS rate, vat_type
  FROM customer_invoice_items WHERE invoice_id = ${id}::UUID ORDER BY line_position`) as Record<string, unknown>[];
const header = async (id: string) => ((await sql`
  SELECT subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax, total_amount::FLOAT8 AS total, tax_rate::FLOAT8 AS rate,
         amounts_are, gl_journal_entry_id, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
  FROM customer_invoices WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
const count = async (company: string) => Number(((await sql`
  SELECT COUNT(*) AS n FROM customer_invoices WHERE company_id = ${company}::UUID`) as { n: string }[])[0]!.n);
const created = (r: Res) => { expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(201); return body<{ id: string }>(r).id; };

/** Load the draft as the edit page does, and PUT the body an unchanged Save sends (its own loader and body builder). */
async function saveUnchanged(id: string): Promise<Res> {
  const d = await detail(id);
  const v = vatAtLoad(d);
  const lines = linesFromStoredItems(d.items ?? [], d.project_id ?? '', v);
  const form = { clientId: String(d.client_id ?? d.customer_id), invoiceDate: d.invoice_date, dueDate: '', billingPeriodStart: '',
    billingPeriodEnd: '', taxRate: v.formRate, notes: d.notes ?? '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
  return put({ ...invoicePutBody(id, { form, lines, taxMode: v.mode }, { omitDueDate: true }), expectedDraftDigest: d.draft_digest });
}

describeIfDisposable('per-line VAT writers (create and the draft edit)', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [c, user, 'owner']);
    }
    // The second company is NOT registered for VAT (companies.vat_system_type = 'none'), with a customer of its own.
    await pool.query("UPDATE companies SET vat_system_type = 'none', vat_period = 'none' WHERE id = $1", [f.other.companyId]);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await sql`DELETE FROM approval_requests WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM approval_rules WHERE document_type <> 'pay_run' AND company_id = ${c}::UUID`;
      await sql`DELETE FROM approval_enforcement WHERE document_type <> 'pay_run' AND company_id = ${c}::UUID`;
      await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID`;
    }
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await dropLineRevenue(f);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  describe('inclusive', () => {
    it('100 x 9.99 entered inclusive: price as entered, net 868.70, VAT 130.30, total 999.00; it posts; an unchanged save moves nothing', async () => {
      const id = created(await create(f.fx.companyId, { invoiceDate: '2026-07-20', amountsAre: 'inclusive',
        items: [{ description: 'Ten', quantity: 100, unitPrice: 9.99, vatType: 'standard' }] }));
      expect(await rows(id)).toEqual([{ description: 'Ten', qty: 100, price: 9.99, amount: 868.7, tax: 130.3, rate: 15, vat_type: 'standard' }]);
      expect(await header(id)).toMatchObject({ subtotal: 868.7, tax: 130.3, total: 999, rate: 15, amounts_are: 'inclusive' });

      const before = { rows: await rows(id), header: await header(id) };
      const saved = await saveUnchanged(id);
      expect(saved.state.statusCode, JSON.stringify(saved.state.body)).toBe(200);
      expect({ rows: await rows(id), header: await header(id) }).toEqual(before);

      const { glJournalEntryId } = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
      expect(await journalLegs(f, glJournalEntryId!)).toEqual([
        L('1100', 999, 0), L('2120', 0, 130.3, { vat: 'standard' }), L('4000', 0, 868.7, { vat: 'standard' }),
      ]);
    });
  });

  describe('the legacy header taxRate', () => {
    it.each([
      [15, 'standard', 150, 15],
      [0, 'zero_rated', 0, 0],
    ] as const)('taxRate %s types every line %s', async (taxRate, type, tax, rate) => {
      const id = created(await create(f.fx.companyId, { invoiceDate: '2026-07-21', taxRate,
        items: [{ description: 'A', quantity: 1, unitPrice: 600 }, { description: 'B', quantity: 1, unitPrice: 400 }] }));
      expect((await rows(id)).map((r) => [r.vat_type, r.rate])).toEqual([[type, rate], [type, rate]]);
      expect(await header(id)).toMatchObject({ subtotal: 1000, tax, total: 1000 + tax, rate });
    });

    it.each([
      ['14 (neither the standard rate nor 0)', { taxRate: 14 }, 'INVOICE_LINE_VAT_REFUSED', /^taxRate 14 is neither the VAT rate on 2026-07-22 \(15%\) nor 0/],
      ['a header rate with a line vatType', { taxRate: 15, items: [{ description: 'A', quantity: 1, unitPrice: 1, vatType: 'standard' }] },
        'INVOICE_LINE_VAT_REFUSED', /not both/],
      ['a line type no document line takes', { items: [{ description: 'A', quantity: 1, unitPrice: 1, vatType: 'reverse_charge' }] },
        'INVOICE_LINE_VAT_REFUSED', /^items\[0\] cannot be reverse_charge/],
    ])('%s is refused 400 with its code, nothing written', async (_l, payload, code, message) => {
      const n = await count(f.fx.companyId);
      const r = await create(f.fx.companyId, { invoiceDate: '2026-07-22', items: [{ description: 'A', quantity: 1, unitPrice: 100 }], ...payload });
      expect(r.state.statusCode).toBe(400);
      expect(codeOf(r)).toBe(code);
      expect((r.state.body as { error: { message: string } }).error.message).toMatch(message);
      expect(await count(f.fx.companyId)).toBe(n);
    });
  });

  describe('a company not registered for VAT', () => {
    it('writes its invoice untyped with no VAT', async () => {
      const id = created(await create(f.other.companyId, { clientId: f.other.customerId, invoiceDate: '2026-07-23',
        items: [{ description: 'Service', quantity: 2, unitPrice: 250 }] }));
      expect(await rows(id)).toEqual([{ description: 'Service', qty: 2, price: 250, amount: 500, tax: null, rate: 0, vat_type: null }]);
      expect(await header(id)).toMatchObject({ subtotal: 500, tax: 0, total: 500, rate: 0 });
    });

    it('refuses a standard line and a 15% header rate, 400 INVOICE_VAT_NOT_REGISTERED, nothing written', async () => {
      const n = await count(f.other.companyId);
      for (const payload of [{ items: [{ description: 'S', quantity: 1, unitPrice: 100, vatType: 'standard' }] },
        { taxRate: 15, items: [{ description: 'S', quantity: 1, unitPrice: 100 }] }]) {
        const r = await create(f.other.companyId, { clientId: f.other.customerId, invoiceDate: '2026-07-23', ...payload });
        expect(r.state.statusCode).toBe(400);
        expect(codeOf(r)).toBe('INVOICE_VAT_NOT_REGISTERED');
        expect((r.state.body as { error: { message: string } }).error.message).toMatch(/not registered for VAT/);
      }
      expect(await count(f.other.companyId)).toBe(n);
    });
  });

  describe('the draft edit', () => {
    it('a line resent without a type keeps its stored type; a new line takes the default chain', async () => {
      const id = created(await create(f.fx.companyId, { invoiceDate: '2026-07-24',
        items: [{ description: 'Rent', quantity: 1, unitPrice: 1000, vatType: 'exempt' }] }));
      const r = await put({ id, items: [{ description: 'Rent', quantity: 1, unitPrice: 1000 }, { description: 'Fee', quantity: 1, unitPrice: 100 }] });
      expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
      expect((await rows(id)).map((x) => [x.description, x.vat_type, x.tax])).toEqual([['Rent', 'exempt', 0], ['Fee', 'standard', 15]]);
      expect(await header(id)).toMatchObject({ subtotal: 1100, tax: 15, total: 1115, rate: 15 });
    });

    it('re-taxes a typed draft whose date moves across 1 April 2018 (14% -> 15%)', async () => {
      const id = created(await create(f.fx.companyId, { invoiceDate: '2018-03-31',
        items: [{ description: 'Old', quantity: 1, unitPrice: 100, vatType: 'standard' }, { description: 'Rent', quantity: 1, unitPrice: 50, vatType: 'exempt' }] }));
      expect((await rows(id)).map((x) => [x.tax, x.rate])).toEqual([[14, 14], [0, 0]]);
      const r = await put({ id, invoiceDate: '2018-04-01' });
      expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
      expect((await rows(id)).map((x) => [x.tax, x.rate])).toEqual([[15, 15], [0, 0]]);
      expect(await header(id)).toMatchObject({ invoice_date: '2018-04-01', subtotal: 150, tax: 15, total: 165, rate: 15 });
    });

    it('saving a LEGACY draft types it: the approval digest moves and a request raised on the old content no longer matches', async () => {
      await sql`INSERT INTO approval_enforcement (company_id, document_type, enabled_by, enabled_at)
                VALUES (${f.fx.companyId}::UUID, 'customer_invoice', ${f.fx.userId}::UUID, NOW() - INTERVAL '1 day')
                ON CONFLICT DO NOTHING`;
      const rule = ((await sql`
        INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role, is_active)
        VALUES (${f.fx.companyId}::UUID, 'Owner signs', 'customer_invoice', 'amount', 'any', 0, 'owner', true) RETURNING id`) as { id: string }[])[0]!.id;
      const id = created(await create(f.fx.companyId, { invoiceDate: '2026-07-25', taxRate: 15,
        items: [{ description: 'Legacy', quantity: 1, unitPrice: 1000 }] }));
      await untypeLines(id); // as a legacy writer stores it
      const digest = async () => String(((await sql`
        SELECT approval_document_digest(${f.fx.companyId}::UUID, 'customer_invoice', ${id}::UUID) AS d`) as { d: string }[])[0]!.d);
      const old = await digest();
      const req = ((await sql`
        INSERT INTO approval_requests (company_id, document_type, document_id, status, requested_by, document_digest, required_role, rule_id)
        VALUES (${f.fx.companyId}::UUID, 'customer_invoice', ${id}::UUID, 'pending', ${f.fx.userId}::UUID, ${old}, 'owner', ${rule}::UUID)
        RETURNING id`) as { id: string }[])[0]!.id;
      await expect(inTx(f.fx, () => assertDocumentUnchanged(f.fx.companyId, req, old))).resolves.toBeUndefined();

      const saved = await saveUnchanged(id);
      expect(saved.state.statusCode, JSON.stringify(saved.state.body)).toBe(200);
      expect((await rows(id)).map((x) => [x.vat_type, x.tax])).toEqual([['standard', 150]]);
      expect(await header(id)).toMatchObject({ subtotal: 1000, tax: 150, total: 1150, amounts_are: 'exclusive' });
      expect(await digest()).not.toBe(old);
      const err = await inTx(f.fx, () => assertDocumentUnchanged(f.fx.companyId, req, old)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalDocumentChangedError);
      const authors = ((await sql`SELECT content_authors FROM customer_invoices WHERE id = ${id}::UUID`) as { content_authors: unknown }[])[0]!.content_authors;
      expect(JSON.stringify(authors)).toContain(user);
      await sql`DELETE FROM approval_requests WHERE company_id = ${f.fx.companyId}::UUID`;
      await sql`DELETE FROM approval_rules WHERE id = ${rule}::UUID`;
      await sql`DELETE FROM approval_enforcement WHERE document_type = 'customer_invoice' AND company_id = ${f.fx.companyId}::UUID`;
    });
  });
});
