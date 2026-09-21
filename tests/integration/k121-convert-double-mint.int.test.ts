/**
 * K-121 round 4 — the two conversions that still minted a document twice.
 *
 * `convertToSalesOrder` was fixed in round 3 with a status-predicated claiming
 * UPDATE. Its two siblings kept the check-then-act:
 *
 *   - `quoteConvertService.convertToInvoice` read `quote.status !== 'accepted'`
 *     and then minted (blind review r3, HIGH-1: two concurrent calls produced
 *     two real customer invoices from one quote);
 *   - `salesOrderWorkflowService.convertSalesOrderToInvoice` read
 *     `order.status !== 'confirmed'` and then minted — the same defect, one
 *     file away, reachable from the sales-order screen's "Invoice" action.
 *
 * In both, the counter row lock serialises the NUMBERING but does not stop the
 * second mint: the loser waits for the winner to commit and then bills the
 * customer again, with `converted_invoice_id` / `invoice_id` pointing at only
 * one of the two, so the duplicate is invisible from the source document.
 *
 * Two pool clients in two open transactions is the real shape of two concurrent
 * requests under `withAuth`; a harness that serialises both on one connection
 * cannot show the race at all.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  convertToInvoice,
  QuoteNotInvoiceableError,
} from '../../src/modules/accounting/services/ar/quoteConvertService';
import {
  convertSalesOrderToInvoice,
  SalesOrderNotInvoiceableError,
} from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID(), customer = crypto.randomUUID();
const raceQuote = crypto.randomUUID(), clickQuote = crypto.randomUUID();
const tenantQuote = crypto.randomUUID();
const raceOrder = crypto.randomUUID(), clickOrder = crypto.randomUUID();

/** How long the winner holds its transaction open while the loser is parked. */
const HOLD_MS = 300;

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

/** Run inside a real request transaction, exactly as withAuth does. */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function seedQuote(id: string, number: string, owner = company) {
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_rate,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','accepted',1000,15,150,1150,$5)`,
    [id, owner, number, customer, user]);
  await pool.query(
    `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,tax_rate,amount,sort_order)
     VALUES($1,'Consulting',1,1000,15,1000,1)`, [id]);
}

async function seedOrder(id: string, number: string) {
  await pool.query(
    `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',1000,150,1150,'confirmed',$5)`,
    [id, company, number, customer, user]);
  await pool.query(
    `INSERT INTO customer_sales_order_items(sales_order_id,line_number,description,quantity,unit_price,tax_rate,line_total)
     VALUES($1,1,'Consulting',1,1000,15,1000)`, [id]);
}

async function invoiceCount(): Promise<number> {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [company]);
  return Number(r.rows[0].n);
}

async function nextNumber(): Promise<number> {
  const r = await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [company]);
  return Number(r.rows[0].next_number);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K121 R4 fixture', other, 'K121 R4 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K121 customer']);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [crypto.randomUUID(), other, 'K121 other customer']);
  await seedQuote(raceQuote, 'K121R4-Q-RACE');
  await seedQuote(clickQuote, 'K121R4-Q-CLICK');
  await seedQuote(tenantQuote, 'K121R4-Q-TENANT', other);
  await seedOrder(raceOrder, 'K121R4-SO-RACE');
  await seedOrder(clickOrder, 'K121R4-SO-CLICK');
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=ANY($1))', [[company, other]]);
    await pool.query('UPDATE customer_sales_orders SET invoice_id=NULL WHERE company_id=$1', [company]);
    await pool.query('UPDATE customer_quotes SET converted_invoice_id=NULL WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_sales_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id=ANY($1)', [[raceQuote, clickQuote, tenantQuote]]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('mints ONE invoice when two requests convert the same quote simultaneously', async () => {
  const before = await invoiceCount();
  const a = await pool.connect(), b = await pool.connect();
  let winner: string;
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    winner = (await als.run(ctxFor(a), () => convertToInvoice(company, raceQuote, user)))!.invoiceId;

    let settled = false;
    const attempt = als.run(ctxFor(b), () => convertToInvoice(company, raceQuote, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A holds the quote row: B is parked on the claiming UPDATE and cannot have
    // decided anything. Without the claim it would already have minted.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(QuoteNotInvoiceableError);
    expect.soft((loser as QuoteNotInvoiceableError).quoteStatus).toBe('converted');
    // The loser is handed the WINNER's invoice, so the client can open it.
    expect.soft((loser as QuoteNotInvoiceableError).existingInvoiceId).toBe(winner);
  } finally {
    a.release(); b.release();
  }

  expect.soft(await invoiceCount()).toBe(before + 1);
  const link = await pool.query(
    'SELECT status, converted_invoice_id FROM customer_quotes WHERE id=$1', [raceQuote]);
  expect.soft(link.rows[0].status).toBe('converted');
  expect(String(link.rows[0].converted_invoice_id)).toBe(winner);
});

it('refuses the double-click retry, burning no invoice number', async () => {
  const first = await inTx(() => convertToInvoice(company, clickQuote, user));
  const before = await nextNumber();
  const count = await invoiceCount();

  const second = await inTx(() => convertToInvoice(company, clickQuote, user))
    .then(() => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(QuoteNotInvoiceableError);
  expect.soft((second as QuoteNotInvoiceableError).existingInvoiceId).toBe(first!.invoiceId);

  expect.soft(await invoiceCount()).toBe(count);
  // Refused before the sequence is touched, so nothing was reserved.
  expect(await nextNumber()).toBe(before);
});

it('will not convert another tenant\'s quote', async () => {
  const before = await invoiceCount();
  // getQuote is company-scoped, so this is a miss, not a refusal — and the
  // claiming UPDATE is company-scoped too, so neither arm can reach the row.
  expect.soft(await convertToInvoice(company, tenantQuote, user)).toBeNull();
  const still = await pool.query('SELECT status FROM customer_quotes WHERE id=$1', [tenantQuote]);
  expect.soft(still.rows[0].status).toBe('accepted');
  expect(await invoiceCount()).toBe(before);
});

it('mints ONE invoice when two requests invoice the same sales order simultaneously', async () => {
  const before = await invoiceCount();
  const a = await pool.connect(), b = await pool.connect();
  let winner: string;
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    winner = (await als.run(ctxFor(a), () => convertSalesOrderToInvoice(company, raceOrder, user))).invoiceId;

    let settled = false;
    const attempt = als.run(ctxFor(b), () => convertSalesOrderToInvoice(company, raceOrder, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(SalesOrderNotInvoiceableError);
    expect.soft((loser as SalesOrderNotInvoiceableError).orderStatus).toBe('invoiced');
    expect.soft((loser as SalesOrderNotInvoiceableError).existingInvoiceId).toBe(winner);
  } finally {
    a.release(); b.release();
  }

  expect.soft(await invoiceCount()).toBe(before + 1);
  const link = await pool.query(
    'SELECT status, invoice_id FROM customer_sales_orders WHERE id=$1', [raceOrder]);
  expect.soft(link.rows[0].status).toBe('invoiced');
  expect(String(link.rows[0].invoice_id)).toBe(winner);
});

it('refuses to invoice an already-invoiced sales order, burning no number', async () => {
  const first = await inTx(() => convertSalesOrderToInvoice(company, clickOrder, user));
  const before = await nextNumber();
  const count = await invoiceCount();

  const second = await inTx(() => convertSalesOrderToInvoice(company, clickOrder, user))
    .then(() => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(SalesOrderNotInvoiceableError);
  expect.soft((second as SalesOrderNotInvoiceableError).existingInvoiceId).toBe(first.invoiceId);

  expect.soft(await invoiceCount()).toBe(count);
  expect(await nextNumber()).toBe(before);
});
