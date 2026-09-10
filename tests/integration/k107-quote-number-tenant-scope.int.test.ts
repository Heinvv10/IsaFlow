/**
 * K-107 round 5, HIGH-1 — the quote number was minted from ANOTHER TENANT's quote.
 *
 * `quoteService.nextQuoteNumber` read
 *   SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1
 * with NO company_id filter, so company A's next quote number was derived from
 * whichever quote was created most recently across the whole platform. Two live
 * consequences: it leaked B's numbering into A's documents, and it RE-ISSUED a
 * number A already held whenever the global newest belonged to a tenant sitting
 * on a lower number. Nothing caught the duplicate — customer_quotes had no
 * uniqueness constraint at all.
 *
 * The number now comes from the company's own `quotation` sequence, and
 * migration 666 adds uq_customer_quotes_company_number so a residual clash with
 * a legacy QUO-nnnnn row fails and renumbers instead of duplicating.
 *
 * Two pool clients in two open transactions is the real shape of two concurrent
 * requests under `withAuth`; a harness that serialises both on one connection
 * cannot show the race at all.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createQuote } from '../../src/modules/accounting/services/ar/quoteService';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID();
const customerA = crypto.randomUUID(), customerB = crypto.randomUUID();

const ctxFor = (client: PoolClient, owner: string) =>
  ({ client, userId: user, companyId: owner, claims: {} } as unknown as Parameters<typeof als.run>[0]);

async function inTx<T>(fn: () => Promise<T>, owner = company): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client, owner), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const LINES = [{ description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 15 }];

async function numbersFor(owner: string): Promise<string[]> {
  const r = await pool.query(
    'SELECT quote_number FROM customer_quotes WHERE company_id=$1 ORDER BY quote_number', [owner]);
  return r.rows.map((x: { quote_number: string }) => String(x.quote_number));
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K107 R5 quote fixture', other, 'K107 R5 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [customerA, company, 'K107 customer', customerB, other, 'K107 other customer']);
  await ensureDocumentNumbers(company);
  await ensureDocumentNumbers(other);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id=ANY($1))', [[company, other]]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('does not take its number from another tenant, and does not repeat its own', async () => {
  const first = await inTx(() => createQuote(company, { customerName: 'A', clientId: customerA, lines: LINES }, user));

  // B mints a much higher number. Under the unscoped read this became the
  // global newest and A's next quote was derived from it.
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_amount,total,created_by)
     VALUES($1,$2,'QUO-09999',$3,'2026-01-01','draft',1,0,1,$4)`,
    [crypto.randomUUID(), other, customerB, user]);

  const second = await inTx(() => createQuote(company, { customerName: 'A', clientId: customerA, lines: LINES }, user));

  expect.soft(second.quoteNumber).not.toContain('9999');
  expect.soft(second.quoteNumber).not.toBe(first.quoteNumber);
  // Its own sequence, one step on: the two numbers are adjacent.
  const seq = (n: string) => Number(n.replace(/\D+/g, ''));
  expect.soft(seq(second.quoteNumber)).toBe(seq(first.quoteNumber) + 1);
  // And B's quote is untouched by A's minting.
  expect(await numbersFor(other)).toEqual(['QUO-09999']);
});

it('mints two DISTINCT numbers for two concurrent creates in one company', async () => {
  const before = (await numbersFor(company)).length;
  const a = await pool.connect(), b = await pool.connect();
  let one: string, two: string;
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    // Both transactions are open at once. The counter row serialises them; the
    // old MAX-of-newest read would have handed both the same number.
    one = (await als.run(ctxFor(a, company),
      () => createQuote(company, { customerName: 'A1', clientId: customerA, lines: LINES }, user))).quoteNumber;
    const pending = als.run(ctxFor(b, company),
      () => createQuote(company, { customerName: 'A2', clientId: customerA, lines: LINES }, user));
    await a.query('COMMIT');
    two = (await pending).quoteNumber;
    await b.query('COMMIT');
  } finally { a.release(); b.release(); }

  expect.soft(one).not.toBe(two);
  const all = await numbersFor(company);
  expect.soft(all.length).toBe(before + 2);
  expect(new Set(all).size).toBe(all.length);
});

it('renumbers past a legacy row holding the number the sequence is about to issue', async () => {
  const peek = await pool.query(
    "SELECT prefix, next_number, padding FROM company_document_numbers WHERE company_id=$1 AND document_type='quotation'",
    [company]);
  const { prefix, next_number, padding } = peek.rows[0];
  const taken = `${prefix}${String(Number(next_number)).padStart(Number(padding), '0')}`;
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','draft',1,0,1,$5)`,
    [crypto.randomUUID(), company, taken, customerA, user]);

  const made = await inTx(() => createQuote(company, { customerName: 'A', clientId: customerA, lines: LINES }, user));
  expect.soft(made.quoteNumber).not.toBe(taken);
  const all = await numbersFor(company);
  expect(new Set(all).size).toBe(all.length);
});

it('writes the quote lines under the number that survived, with none orphaned', async () => {
  const made = await inTx(() => createQuote(company, {
    customerName: 'A', clientId: customerA,
    lines: [
      { description: 'One', quantity: 2, unitPrice: 100, taxRate: 15 },
      { description: 'Two', quantity: 1, unitPrice: 50, taxRate: 15 },
    ],
  }, user));
  const lines = await pool.query(
    'SELECT amount FROM customer_quote_lines WHERE quote_id=$1 ORDER BY sort_order', [made.id]);
  expect.soft(lines.rows.length).toBe(2);
  // The document foots: sum(lines) = header subtotal.
  const sum = lines.rows.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
  expect.soft(sum).toBeCloseTo(made.subtotal, 2);
  expect.soft(made.total).toBeCloseTo(made.subtotal + made.taxAmount, 2);
  // No lines left behind by an earlier attempt of this quote's number.
  const orphans = await pool.query(
    `SELECT count(*)::int AS n FROM customer_quote_lines l
      WHERE NOT EXISTS (SELECT 1 FROM customer_quotes q WHERE q.id = l.quote_id)`);
  expect(Number(orphans.rows[0].n)).toBe(0);
});

it('refuses a duplicate (company_id, quote_number) at the database', async () => {
  const dup = 'K107R5-DUP';
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','draft',1,0,1,$5)`,
    [crypto.randomUUID(), company, dup, customerA, user]);
  const again = pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','draft',1,0,1,$5)`,
    [crypto.randomUUID(), company, dup, customerA, user]);
  // Either name is correct: migration 666 and the parallel K-060 branch add the
  // same unique (company_id, quote_number) under different names, and 666 skips
  // when one is already there. Both are in the service's renumber list.
  const err = await again.then(() => null, (e: unknown) => e as { code?: string; constraint?: string });
  expect.soft(err?.code).toBe('23505');
  expect.soft([
    'uq_customer_quotes_company_number',
    'uq_customer_quotes_company_quote_number',
  ]).toContain(err?.constraint);

  // The SAME number in another tenant is fine — the domain is per company.
  await expect(pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,status,subtotal,tax_amount,total,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01','draft',1,0,1,$5)`,
    [crypto.randomUUID(), other, dup, customerB, user])).resolves.toBeTruthy();
});
