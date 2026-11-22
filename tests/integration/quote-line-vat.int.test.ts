/**
 * Per-line VAT on quotes (migration 1024) against real PostgreSQL:
 * - createQuote types each line (standard / zero_rated / exempt), stores net, VAT, type and rate per line and the
 *   header as their sum; the converted invoice carries the same types and figures, and posts one leg per type;
 * - an inclusive quote stores its unit prices as entered and converts to an inclusive invoice of the same gross;
 * - the legacy per-line taxRate types lines; 14 is a 400 with INVOICE_LINE_VAT_REFUSED through the route, nothing written;
 * - a company not registered for VAT writes untyped lines with no VAT, and its quote converts untyped;
 * - updateQuote keeps an identical stored line's type;
 * - the quote PDF prints one VAT row per type;
 * - a LEGACY quote (planted with NULL types) still converts as stored, untyped.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { createQuote, updateQuote } from '@/modules/accounting/services/ar/quoteService';
import { convertToInvoice } from '@/modules/accounting/services/ar/quoteConvertService';
import { generateQuotePdf } from '@/modules/accounting/services/ar/quotePdfBuilder';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { fmtZAR } from '@/modules/accounting/services/core/pdfShared';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L } from './helpers/lineVatFixture';
import { callRoute, createUser } from './r035-approval.helpers';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';

type Line = { description: string; quantity: number; unitPrice: number; vatType?: string; taxRate?: number };
const quoteOf = (company: string, customer: string, lines: Line[], extra: Record<string, unknown> = {}) =>
  inTx(company === f.fx.companyId ? f.fx : f.other, () => createQuote(company, {
    customerName: 'Quote client', clientId: customer, quoteDate: '2026-11-11', lines, ...extra,
  } as never, f.fx.userId));
const quoteLines = async (id: string) => (await sql`
  SELECT description, unit_price::FLOAT8 AS price, amount::FLOAT8 AS amount, tax_amount::FLOAT8 AS tax, tax_rate::FLOAT8 AS rate, vat_type
  FROM customer_quote_lines WHERE quote_id = ${id}::UUID ORDER BY sort_order`) as Record<string, unknown>[];
const quoteHead = async (id: string) => ((await sql`
  SELECT subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax, total::FLOAT8 AS total, tax_rate::FLOAT8 AS rate, amounts_are
  FROM customer_quotes WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
const invLines = async (id: string) => (await sql`
  SELECT description, unit_price::FLOAT8 AS price, amount::FLOAT8 AS amount, tax_amount::FLOAT8 AS tax, tax_rate::FLOAT8 AS rate, vat_type
  FROM customer_invoice_items WHERE invoice_id = ${id}::UUID ORDER BY line_position`) as Record<string, unknown>[];
const invHead = async (id: string) => ((await sql`
  SELECT subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax, total_amount::FLOAT8 AS total, tax_rate::FLOAT8 AS rate,
         amounts_are, gl_journal_entry_id
  FROM customer_invoices WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;

async function convert(fx: LineRevenueFixture['fx'], quoteId: string): Promise<string> {
  await sql`UPDATE customer_quotes SET status = 'accepted' WHERE id = ${quoteId}::UUID`;
  return (await inTx(fx, () => convertToInvoice(fx.companyId, quoteId, fx.userId)))!.invoiceId;
}
const pick = (rows: Record<string, unknown>[]) => rows.map((r) => [r.vat_type, r.price, r.amount, r.tax, r.rate]);

describeIfDisposable('per-line VAT on quotes', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [f.fx.companyId, user, 'owner']);
    await pool.query("UPDATE companies SET vat_system_type = 'none', vat_period = 'none' WHERE id = $1", [f.other.companyId]);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    for (const c of [f.fx.companyId, f.other.companyId]) {
      await sql`DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id = ${c}::UUID)`;
      await sql`UPDATE customer_quotes SET converted_invoice_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM customer_quotes WHERE company_id = ${c}::UUID`;
    }
    await pool?.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await pool?.end();
    await dropLineRevenue(f);
  });

  it('a mixed quote stores per-line VAT; its invoice carries the same types and figures and posts one leg per type', async () => {
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, [
      { description: 'Shoot', quantity: 2, unitPrice: 100, vatType: 'standard' },
      { description: 'Export', quantity: 1, unitPrice: 50, vatType: 'zero_rated' },
      { description: 'Rent', quantity: 1, unitPrice: 30, vatType: 'exempt' },
    ]);
    expect(pick(await quoteLines(q.id))).toEqual([['standard', 100, 200, 30, 15], ['zero_rated', 50, 50, 0, 0], ['exempt', 30, 30, 0, 0]]);
    expect(await quoteHead(q.id)).toEqual({ subtotal: 280, tax: 30, total: 310, rate: 15, amounts_are: 'exclusive' });
    const inv = await convert(f.fx, q.id);
    expect(pick(await invLines(inv))).toEqual(pick(await quoteLines(q.id)));
    expect(await invHead(inv)).toMatchObject({ subtotal: 280, tax: 30, total: 310, rate: 15, amounts_are: 'exclusive' });
    await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, inv, f.fx.userId));
    expect(await journalLegs(f, String((await invHead(inv)).gl_journal_entry_id))).toEqual([
      L('1100', 310, 0), L('2120', 0, 30, { vat: 'standard' }),
      L('4000', 0, 30, { vat: 'exempt' }), L('4000', 0, 50, { vat: 'zero_rated' }), L('4000', 0, 200, { vat: 'standard' }),
    ]);
  });

  it('an inclusive quote stores its prices as entered and converts to an inclusive invoice of the same gross', async () => {
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, [{ description: 'Day rate', quantity: 3, unitPrice: 10, vatType: 'standard' }],
      { amountsAre: 'inclusive' });
    expect(pick(await quoteLines(q.id))).toEqual([['standard', 10, 26.09, 3.91, 15]]);
    expect(await quoteHead(q.id)).toEqual({ subtotal: 26.09, tax: 3.91, total: 30, rate: 15, amounts_are: 'inclusive' });
    const inv = await convert(f.fx, q.id);
    expect(pick(await invLines(inv))).toEqual([['standard', 10, 26.09, 3.91, 15]]);
    expect(await invHead(inv)).toMatchObject({ subtotal: 26.09, tax: 3.91, total: 30, amounts_are: 'inclusive' });
  });

  it('the legacy per-line taxRate types lines; 14% is a 400 with its code through the route, nothing written', async () => {
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, [
      { description: 'A', quantity: 1, unitPrice: 100, taxRate: 15 }, { description: 'B', quantity: 1, unitPrice: 100, taxRate: 0 },
    ]);
    expect((await quoteLines(q.id)).map((l) => l.vat_type)).toEqual(['standard', 'zero_rated']);
    const before = Number(((await sql`SELECT COUNT(*) AS n FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);
    const r = await callRoute(customerQuotes, tokens[user]!, f.fx.companyId, 'POST',
      { customerName: 'x', clientId: f.fx.customerId, lines: [{ description: 'A', quantity: 1, unitPrice: 1, taxRate: 14 }] }, '/api/accounting/customer-quotes');
    expect(r.state.statusCode).toBe(400);
    expect((r.state.body as { error?: { details?: { code?: string } } }).error?.details?.code).toBe('INVOICE_LINE_VAT_REFUSED');
    const after = Number(((await sql`SELECT COUNT(*) AS n FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);
    expect(after).toBe(before);
  });

  it('a company not registered for VAT writes untyped lines, no VAT, and its quote converts untyped', async () => {
    const q = await quoteOf(f.other.companyId, f.other.customerId, [
      { description: 'A', quantity: 2, unitPrice: 100 }, { description: 'B', quantity: 1, unitPrice: 5, vatType: 'exempt' },
    ], { amountsAre: 'inclusive' });
    expect(pick(await quoteLines(q.id))).toEqual([[null, 100, 200, null, 0], [null, 5, 5, null, 0]]);
    expect(await quoteHead(q.id)).toEqual({ subtotal: 205, tax: 0, total: 205, rate: 0, amounts_are: 'exclusive' });
    const inv = await convert(f.other, q.id);
    expect(pick(await invLines(inv))).toEqual([[null, 100, 200, null, 0], [null, 5, 5, null, 0]]);
    expect(await invHead(inv)).toMatchObject({ subtotal: 205, tax: 0, total: 205, rate: 0 });
  });

  it('updateQuote keeps a stored line\'s type, identical or edited in place; a new line takes the default chain', async () => {
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, [
      { description: 'Rent', quantity: 1, unitPrice: 30, vatType: 'exempt' }, { description: 'Fee', quantity: 1, unitPrice: 10, vatType: 'zero_rated' },
    ]);
    await inTx(f.fx, () => updateQuote(f.fx.companyId, q.id, { customerName: 'Quote client', clientId: f.fx.customerId, lines: [
      { description: 'Rent', quantity: 1, unitPrice: 30 }, { description: 'Fee', quantity: 2, unitPrice: 10 }, { description: 'New', quantity: 1, unitPrice: 10 },
    ] }, f.fx.userId));
    expect(pick(await quoteLines(q.id))).toEqual([['exempt', 30, 30, 0, 0], ['zero_rated', 10, 20, 0, 0], ['standard', 10, 10, 1.5, 15]]);
    expect(await quoteHead(q.id)).toEqual({ subtotal: 60, tax: 1.5, total: 61.5, rate: 15, amounts_are: 'exclusive' });
  });

  it('an edit that only moves a line\'s VAT type (exempt to zero-rated, same figures) makes the editor an author', async () => {
    const lines = [{ description: 'Rent', quantity: 1, unitPrice: 30, vatType: 'exempt' }];
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, lines);
    const authors = async () => ((await sql`SELECT content_authors::TEXT[] AS a FROM customer_quotes WHERE id = ${q.id}::UUID`) as { a: string[] }[])[0]!.a;
    const edit = (vatType: string, notes?: string) => inTx(f.fx, () => updateQuote(f.fx.companyId, q.id,
      { customerName: 'Quote client', clientId: f.fx.customerId, quoteDate: '2026-11-11', notes, lines: [{ ...lines[0]!, vatType }] }, f.fx.userId));
    await edit('exempt', 'notes only');
    expect(await authors()).toEqual([]);
    await edit('zero_rated');
    expect(await authors()).toEqual([f.fx.userId]);
  });

  it('the quote PDF prints one VAT row per type, with the stored figures', async () => {
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, [
      { description: 'Shoot', quantity: 1, unitPrice: 100, vatType: 'standard' }, { description: 'Rent', quantity: 1, unitPrice: 40, vatType: 'exempt' },
    ]);
    const text = [...(await generateQuotePdf(f.fx.companyId, q.id)).toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
      .map((m) => m[1]!.replace(/\\([()\\])/g, '$1'));
    const nb = (s: string) => s.replace(/ /g, ' ');
    const shown = text.map(nb);
    expect(shown).toContain(nb(`VAT Standard (15%) on ${fmtZAR(100)}`));
    expect(shown).toContain(nb(`VAT Exempt on ${fmtZAR(40)}`));
    expect(shown).toContain(nb(fmtZAR(15)));
  });

  it('a LEGACY quote (NULL types, a 14% line) converts as stored, untyped, never re-priced', async () => {
    const q = await quoteOf(f.fx.companyId, f.fx.customerId, [{ description: 'Old', quantity: 1, unitPrice: 100, vatType: 'standard' }]);
    await sql`UPDATE customer_quote_lines SET vat_type = NULL, tax_amount = NULL, tax_rate = 14 WHERE quote_id = ${q.id}::UUID`;
    await sql`UPDATE customer_quotes SET amounts_are = NULL, tax_amount = 14, total = 114, tax_rate = 14 WHERE id = ${q.id}::UUID`;
    const inv = await convert(f.fx, q.id);
    expect(pick(await invLines(inv))).toEqual([[null, 100, 100, null, 14]]);
    expect(await invHead(inv)).toMatchObject({ subtotal: 100, tax: 14, total: 114, rate: 14, amounts_are: null });
  });
});
