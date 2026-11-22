/**
 * Per-line VAT on quotes, review round 1 (blind reviews of c7fcc2eb0d), through the real routes on real PostgreSQL:
 * - a PUT naming no amountsAre keeps an inclusive quote's mode and figures;
 * - a LEGACY 14% quote (saved before migration 1024) edits notes-only with its lines as the form resends them: 200, its
 *   lines and figures as stored;
 * - a legacy taxRate 0 keeps a stored exempt line exempt (price changed), and the exempt twin of a deleted standard line;
 * - a quote backdated across the 2018 rate change converts with a QUOTE_TOTAL_CHANGED warning in the response;
 * - an already-converted, partly typed quote answers 409 with the existing invoice id (not a VAT 400);
 * - a typed quote with an exempt line is refused conversion to a sales order (400), nothing written;
 * - a quantity that stores as 0 (0.004) is a 400.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import quotesAction from '../../pages/api/accounting/customer-quotes-action';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { callRoute, createUser } from './r035-approval.helpers';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';
const URL = '/api/accounting/customer-quotes';
const ACTION = '/api/accounting/customer-quotes-action';

type Res = Awaited<ReturnType<typeof callRoute>>;
const data = <T>(r: Res) => (r.state.body as { data: T }).data;
const call = (method: string, body: Record<string, unknown>) => callRoute(customerQuotes, tokens[user]!, f.fx.companyId, method, body, URL);
const action = (id: string, act: string) => callRoute(quotesAction, tokens[user]!, f.fx.companyId, 'POST', { id, action: act }, ACTION);
async function create(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', { customerName: 'Review client', clientId: f.fx.customerId, quoteDate: '2026-11-11', lines, ...extra });
  expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(201);
  return data<{ id: string }>(r).id;
}
const put = (id: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  call('PUT', { id, customerName: 'Review client', clientId: f.fx.customerId, quoteDate: '2026-11-11', lines, ...extra });
const lines = async (id: string) => (await sql`
  SELECT description, unit_price::FLOAT8 AS price, amount::FLOAT8 AS amount, tax_amount::FLOAT8 AS tax, tax_rate::FLOAT8 AS rate, vat_type
  FROM customer_quote_lines WHERE quote_id = ${id}::UUID ORDER BY sort_order`) as Record<string, unknown>[];
const head = async (id: string) => ((await sql`
  SELECT subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax, total::FLOAT8 AS total, tax_rate::FLOAT8 AS rate, amounts_are, notes
  FROM customer_quotes WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!;
const count = async (table: 'customer_quotes' | 'customer_sales_orders') => Number(((await pool.query(
  `SELECT COUNT(*) AS n FROM ${table} WHERE company_id = $1`, [f.fx.companyId])).rows[0] as { n: string }).n);

describeIfDisposable('per-line VAT on quotes, review round 1', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [f.fx.companyId, user, 'owner']);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    await sql`DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID)`;
    await sql`UPDATE customer_quotes SET converted_invoice_id = NULL WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID`;
    await pool?.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await pool?.end();
    await dropLineRevenue(f);
  });

  it('a PUT that names no amountsAre keeps an inclusive quote inclusive (115 stays 115)', async () => {
    const id = await create([{ description: 'A', quantity: 1, unitPrice: 115, vatType: 'standard' }], { amountsAre: 'inclusive' });
    expect((await put(id, [{ description: 'A', quantity: 1, unitPrice: 115, vatType: 'standard' }], { notes: 'n' })).state.statusCode).toBe(200);
    expect(await head(id)).toMatchObject({ subtotal: 100, tax: 15, total: 115, amounts_are: 'inclusive' });
  });

  it('a LEGACY 14% quote edited notes-only (its lines resent at 14) succeeds and keeps every figure', async () => {
    const id = await create([{ description: 'Old', quantity: 1, unitPrice: 100, vatType: 'standard' }]);
    await sql`UPDATE customer_quote_lines SET vat_type = NULL, tax_amount = NULL, tax_rate = 14 WHERE quote_id = ${id}::UUID`;
    await sql`UPDATE customer_quotes SET amounts_are = NULL, tax_amount = 14, total = 114, tax_rate = 14 WHERE id = ${id}::UUID`;
    const before = await lines(id);
    const r = await put(id, [{ description: 'Old', quantity: 1, unitPrice: 100, taxRate: 14 }], { notes: 'only the notes' });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
    expect(await lines(id)).toEqual(before);
    expect(await head(id)).toEqual({ subtotal: 100, tax: 14, total: 114, rate: 14, amounts_are: null, notes: 'only the notes' });
  });

  it('a legacy taxRate 0 keeps a stored exempt line exempt when its price changes', async () => {
    const id = await create([{ description: 'Rent', quantity: 1, unitPrice: 100, vatType: 'exempt' }]);
    expect((await put(id, [{ description: 'Rent', quantity: 1, unitPrice: 120, taxRate: 0 }])).state.statusCode).toBe(200);
    expect((await lines(id)).map((l) => [l.vat_type, l.amount])).toEqual([['exempt', 120]]);
  });

  it('twins "Widget 1 x 100" standard and exempt, the standard one deleted: the remaining line stays exempt', async () => {
    const id = await create([{ description: 'Widget', quantity: 1, unitPrice: 100, vatType: 'standard' }, { description: 'Widget', quantity: 1, unitPrice: 100, vatType: 'exempt' }]);
    expect((await put(id, [{ description: 'Widget', quantity: 1, unitPrice: 100, taxRate: 0 }])).state.statusCode).toBe(200);
    expect((await lines(id)).map((l) => [l.vat_type, l.tax])).toEqual([['exempt', 0]]);
    expect(await head(id)).toMatchObject({ subtotal: 100, tax: 0, total: 100 });
  });

  it('a quote dated 2018-03-31 (14%) converts at today\'s 15% and the response says so', async () => {
    const id = await create([{ description: 'Backdated', quantity: 1, unitPrice: 100, vatType: 'standard' }], { quoteDate: '2018-03-31' });
    expect(await head(id)).toMatchObject({ tax: 14, total: 114 });
    expect((await action(id, 'accept')).state.statusCode).toBe(200);
    const r = await action(id, 'convert');
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
    expect(data<{ warnings: unknown[] }>(r).warnings).toEqual([expect.objectContaining({
      code: 'QUOTE_TOTAL_CHANGED', quoteTotal: 114, invoiceTotal: 115, quoteRatePct: 14, invoiceRatePct: 15,
    })]);
  });

  it('an already-converted, partly typed quote answers 409 with the existing invoice id, not a VAT 400', async () => {
    const id = await create([{ description: 'A', quantity: 1, unitPrice: 10, vatType: 'standard' }, { description: 'B', quantity: 1, unitPrice: 10, vatType: 'standard' }]);
    expect((await action(id, 'accept')).state.statusCode).toBe(200);
    const first = await action(id, 'convert');
    expect(first.state.statusCode).toBe(200);
    await sql`UPDATE customer_quote_lines SET vat_type = NULL, tax_amount = NULL WHERE quote_id = ${id}::UUID AND description = 'B'`;
    const again = await action(id, 'convert');
    expect(again.state.statusCode).toBe(409);
    expect((again.state.body as { error?: { details?: { invoiceId?: string } } }).error?.details?.invoiceId).toBe(data<{ invoiceId: string }>(first).invoiceId);
  });

  it('a typed quote with an exempt line is refused conversion to a sales order, nothing written', async () => {
    const id = await create([{ description: 'Rent', quantity: 1, unitPrice: 100, vatType: 'exempt' }]);
    expect((await action(id, 'accept')).state.statusCode).toBe(200);
    const orders = await count('customer_sales_orders');
    const r = await action(id, 'convert-to-order');
    expect(r.state.statusCode).toBe(400);
    expect((r.state.body as { error?: { message?: string } }).error?.message).toMatch(/exempt from VAT/);
    expect(await count('customer_sales_orders')).toBe(orders);
    expect((await head(id))).toMatchObject({ total: 100 });
  });

  it('a quantity that stores as 0 (0.004) is a 400, nothing written', async () => {
    const quotes = await count('customer_quotes');
    const r = await call('POST', { customerName: 'x', clientId: f.fx.customerId, lines: [{ description: 'A', quantity: 0.004, unitPrice: 100 }] });
    expect(r.state.statusCode).toBe(400);
    expect(await count('customer_quotes')).toBe(quotes);
  });
});
