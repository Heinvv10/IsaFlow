/**
 * The CLAIM wait is bounded too. Blind review r4, LOW-2 and LOW-3.
 *
 * LOW-2. The status-predicated claiming UPDATE is taken deliberately BEFORE the
 * document-number counter row, so that a loser burns no number. That ordering
 * moved the first blocking point a concurrent caller hits onto the claim — and
 * the claim had no `lock_timeout`, while the counter row it was placed in front
 * of does. A winner whose request stalled mid-transaction therefore parked every
 * other caller on that document forever: the unbounded hang the counter row's
 * 5s ceiling exists to prevent, reintroduced one statement earlier.
 *
 * LOW-3. `reserveNextDocumentNumber` restored `lock_timeout` to DEFAULT only
 * after the counter row was read. On the `No document number config for type …`
 * throw — which is NOT the timeout path, so the transaction is still usable —
 * the 5s ceiling stayed set for the rest of the request, and a later unrelated
 * write could then fail on a lock wait that had nothing to do with numbering.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { convertToInvoice } from '../../src/modules/accounting/services/ar/quoteConvertService';
import { DocumentClaimLockTimeoutError } from '../../src/modules/accounting/services/core/documentClaimLock';
import {
  ensureDocumentNumbers,
  reserveNextDocumentNumber,
} from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const stuckQuote = crypto.randomUUID();

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 claim-lock fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 claim customer']);
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_rate,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','accepted',1000,15,150,1150,$5)`,
    [stuckQuote, company, 'K107R5-Q-STUCK', customer, user]);
  await pool.query(
    `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,tax_rate,amount,sort_order)
     VALUES($1,'Consulting',1,1000,15,1000,1)`, [stuckQuote]);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('UPDATE customer_quotes SET converted_invoice_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id=$1', [stuckQuote]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('gives the blocked converter a typed error instead of parking on a stalled winner', async () => {
  const holder = await pool.connect(), blocked = await pool.connect();
  try {
    await holder.query('BEGIN');
    await blocked.query('BEGIN');
    // The winner claims the quote and then STALLS — it never commits, which is
    // what a hung request looks like from the loser's side.
    await als.run(ctxFor(holder), () => convertToInvoice(company, stuckQuote, user));

    const startedAt = Date.now();
    const err = await als
      .run(ctxFor(blocked), () => convertToInvoice(company, stuckQuote, user))
      .then(() => null, (e: unknown) => e);
    const waited = Date.now() - startedAt;

    expect.soft(err).toBeInstanceOf(DocumentClaimLockTimeoutError);
    expect.soft((err as DocumentClaimLockTimeoutError).documentKind).toBe('quote');
    // Bounded: it waited the 5s and gave up, rather than waiting for a holder
    // that is never going to commit.
    expect.soft(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(15000);

    await blocked.query('ROLLBACK');
    await holder.query('ROLLBACK');
  } finally {
    holder.release(); blocked.release();
  }
}, 30000);

it('restores the default timeout when the document type has no config, not only on success', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const err = await als
      .run(ctxFor(client), () => reserveNextDocumentNumber(company, 'no_such_document_type'))
      .then(() => null, (e: unknown) => e);
    expect.soft((err as Error).message).toMatch(/No document number config/);
    // The transaction is still usable here — this is not 55P03 — so the 5s
    // ceiling must not survive onto the request's later statements.
    const shown = await client.query('SHOW lock_timeout');
    expect(shown.rows[0].lock_timeout).toBe('0');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
