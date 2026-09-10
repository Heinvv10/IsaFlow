/**
 * K-122 (M1) — two concurrent renders of the same invoice must not mint two
 * portal tokens.
 *
 * getOrMintInvoicePortalToken reads portal_token and then writes it. The
 * dunning cron and a manual /dunning/send can render the same invoice at the
 * same time: both see NULL, both mint, the last UPDATE wins, and the email the
 * loser already sent carries a token that is not in the database — the exact
 * 404 K-122 exists to remove.
 *
 * The rival writer below lands BETWEEN the service's SELECT and its UPDATE, on
 * a separate connection, so this is a real interleave of the real code path and
 * not a replay of the statement.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

/**
 * Runs once, immediately before the service issues its mint UPDATE — i.e. after
 * its own SELECT has already returned NULL. That is the race window: hooking
 * the SELECT instead would let the rival win before the read, and the service
 * would return early on the existing token without ever reaching the UPDATE.
 */
let beforeNextTokenWrite: (() => Promise<void>) | null = null;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    const isMint = /UPDATE\s+customer_invoices/.test(text) && /SET\s+portal_token/.test(text);
    if (beforeNextTokenWrite && isMint) {
      const hook = beforeNextTokenWrite;
      beforeNextTokenWrite = null;
      return hook().then(() => original.sql(strings, ...values));
    }
    return original.sql(strings, ...values);
  };
  return { ...original, sql };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID();
const RIVAL_TOKEN = 'f'.repeat(64);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K122b fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K122b customer']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122B-INV-1',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [invoice, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('returns the token a concurrent render already stored, never its own mint', async () => {
  const { getOrMintInvoicePortalToken } =
    await import('../../src/modules/accounting/services/ar/portalTokenService');

  await pool.query('UPDATE customer_invoices SET portal_token = NULL WHERE id = $1', [invoice]);

  // The rival render, on its own pooled connection, commits between our SELECT
  // (which saw NULL) and our own mint UPDATE.
  let rivalRan = false;
  beforeNextTokenWrite = async () => {
    await pool.query(
      'UPDATE customer_invoices SET portal_token = $1 WHERE id = $2',
      [RIVAL_TOKEN, invoice]);
    rivalRan = true;
  };

  const { token, url } = await getOrMintInvoicePortalToken(invoice, company);

  // Proves the interleave actually happened rather than the read short-circuiting.
  expect(rivalRan).toBe(true);

  const { rows } = await pool.query('SELECT portal_token FROM customer_invoices WHERE id=$1', [invoice]);
  // The rival's token is the one already emailed; it must survive, and it must
  // be the one we hand back.
  expect(rows[0].portal_token).toBe(RIVAL_TOKEN);
  expect(token).toBe(RIVAL_TOKEN);
  expect(url).toContain(RIVAL_TOKEN);
});

it('is idempotent on a second call once a token exists', async () => {
  const { getOrMintInvoicePortalToken } =
    await import('../../src/modules/accounting/services/ar/portalTokenService');

  const first = await getOrMintInvoicePortalToken(invoice, company);
  const second = await getOrMintInvoicePortalToken(invoice, company);
  expect(second.token).toBe(first.token);
});

it('does not mint for another tenant', async () => {
  const { getOrMintInvoicePortalToken } =
    await import('../../src/modules/accounting/services/ar/portalTokenService');
  const other = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K122b other tenant']);
  try {
    await expect(getOrMintInvoicePortalToken(invoice, other))
      .rejects.toThrow(/not found or not eligible/i);
  } finally {
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});
