/**
 * K-107 round 5, HIGH-2 — WIP / time-entry invoicing billed the client twice.
 *
 * `practiceWipService.generateWipInvoice` SELECTed the eligible entries
 * (`status='approved' AND billed_at IS NULL`), then minted a full
 * customer_invoices row with lines, then called `markEntriesBilled` — whose
 * predicated UPDATE returns a row count the caller DISCARDED. Two concurrent
 * generations over the same ids therefore both read the entries as eligible,
 * both billed the client, and the loser marked zero rows: a second real invoice,
 * linked to nothing, that has to be credit-noted.
 *
 * It also carried a third MAX(invoice_number)+1 generator inside the sequence's
 * own uniqueness domain, and a retry that matched on the word "unique" with no
 * savepoint — so a real 23505 left the request transaction aborted and every
 * later attempt failed 25P02, whose message does not contain "unique".
 *
 * Two pool clients in two open transactions is the real shape of two concurrent
 * requests under `withAuth`; a harness that serialises both on one connection
 * cannot show the race at all.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateWipInvoice } from '../../src/modules/accounting/services/practice/practiceWipService';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID(), otherCustomer = crypto.randomUUID();
const practiceClient = crypto.randomUUID(), otherClient = crypto.randomUUID();

/** How long the winner holds its transaction open while the loser is parked. */
const HOLD_MS = 300;

const ctxFor = (client: PoolClient, owner = company) =>
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

async function seedEntry(id: string, owner = company, pc = practiceClient): Promise<string> {
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,
                              billable,invoiced,status,practice_client_id,applied_rate,line_total,origin)
     VALUES($1,$2,$3,'Audit fieldwork','2026-01-05',4,250,true,false,'approved',$4,250,1000,'manual')`,
    [id, owner, user, pc]);
  return id;
}

async function invoiceCount(owner = company): Promise<number> {
  const r = await pool.query('SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [owner]);
  return Number(r.rows[0].n);
}

async function nextNumber(owner = company): Promise<number> {
  const r = await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [owner]);
  return Number(r.rows[0].next_number);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K107 R5 WIP fixture', other, 'K107 R5 WIP other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [customer, company, 'K107 WIP customer', otherCustomer, other, 'K107 WIP other customer']);
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
     VALUES($1,$2,'K107 practice client','hourly','active',$3),
            ($4,$5,'K107 other practice client','hourly','active',$6)`,
    [practiceClient, company, customer, otherClient, other, otherCustomer]);
  await ensureDocumentNumbers(company);
  await ensureDocumentNumbers(other);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE time_entries SET invoice_id=NULL WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=ANY($1))', [[company, other]]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM time_entries WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM practice_clients WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('mints ONE invoice when two requests bill the same WIP simultaneously', async () => {
  const entry = await seedEntry(crypto.randomUUID());
  const before = await invoiceCount();
  const a = await pool.connect(), b = await pool.connect();
  let winner: string;
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    winner = (await als.run(ctxFor(a), () => generateWipInvoice(company, user, {
      practiceClientId: practiceClient, timeEntryIds: [entry],
    }))).invoiceId;

    let settled = false;
    const attempt = als.run(ctxFor(b), () => generateWipInvoice(company, user, {
      practiceClientId: practiceClient, timeEntryIds: [entry],
    }));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A holds the entry row: B is parked on the lock and cannot have decided
    // anything. Without it B would already have minted a second invoice.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(Error);
    expect.soft((loser as Error).message).toContain('no eligible approved time entries');
  } finally { a.release(); b.release(); }

  expect.soft(await invoiceCount()).toBe(before + 1);
  const link = await pool.query('SELECT status, invoice_id FROM time_entries WHERE id=$1', [entry]);
  expect.soft(link.rows[0].status).toBe('billed');
  expect(String(link.rows[0].invoice_id)).toBe(winner);
});

it('refuses the double-click retry, burning no invoice number', async () => {
  const entry = await seedEntry(crypto.randomUUID());
  const first = await inTx(() => generateWipInvoice(company, user, {
    practiceClientId: practiceClient, timeEntryIds: [entry],
  }));
  const beforeNumber = await nextNumber();
  const beforeCount = await invoiceCount();

  const second = await inTx(() => generateWipInvoice(company, user, {
    practiceClientId: practiceClient, timeEntryIds: [entry],
  })).then(() => null, (err: unknown) => err);

  expect.soft(second).toBeInstanceOf(Error);
  expect.soft((second as Error).message).toContain('no eligible approved time entries');
  expect.soft(await invoiceCount()).toBe(beforeCount);
  // Refused before the sequence is touched, so nothing was reserved.
  expect.soft(await nextNumber()).toBe(beforeNumber);
  expect(first.invoiceNumber).not.toContain('INV-');
});

it('the legitimate path still bills, foots, and marks every entry', async () => {
  const one = await seedEntry(crypto.randomUUID());
  const two = await seedEntry(crypto.randomUUID());
  const result = await inTx(() => generateWipInvoice(company, user, {
    practiceClientId: practiceClient, timeEntryIds: [one, two],
  }));

  expect.soft(result.lineCount).toBe(2);
  expect.soft(result.subtotal).toBeCloseTo(2000, 2);
  expect.soft(result.totalAmount).toBeCloseTo(result.subtotal + result.taxAmount, 2);

  const header = await pool.query(
    'SELECT invoice_number, subtotal, tax_amount, total_amount FROM customer_invoices WHERE id=$1',
    [result.invoiceId]);
  // The document foots: sum(lines) = header subtotal, and header = subtotal+tax.
  const lines = await pool.query(
    'SELECT amount FROM customer_invoice_items WHERE invoice_id=$1', [result.invoiceId]);
  const sum = lines.rows.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
  expect.soft(sum).toBeCloseTo(Number(header.rows[0].subtotal), 2);
  expect.soft(Number(header.rows[0].total_amount))
    .toBeCloseTo(Number(header.rows[0].subtotal) + Number(header.rows[0].tax_amount), 2);
  // The number came from the company sequence, not the old MAX()+1 generator.
  const seq = await pool.query(
    "SELECT prefix FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [company]);
  expect.soft(String(header.rows[0].invoice_number)).toContain(String(seq.rows[0].prefix));

  const marked = await pool.query(
    "SELECT count(*)::int AS n FROM time_entries WHERE id=ANY($1) AND status='billed' AND invoice_id=$2",
    [[one, two], result.invoiceId]);
  expect(Number(marked.rows[0].n)).toBe(2);
});

it('will not bill another tenant\'s time entries', async () => {
  const mine = await seedEntry(crypto.randomUUID());
  const theirs = await seedEntry(crypto.randomUUID(), other, otherClient);
  const before = await invoiceCount();

  // Both ids passed in, but the entry read is company-scoped, so only mine is
  // eligible — the other tenant's hours must not reach my customer's invoice.
  const result = await inTx(() => generateWipInvoice(company, user, {
    practiceClientId: practiceClient, timeEntryIds: [mine, theirs],
  }));
  expect.soft(result.lineCount).toBe(1);
  expect.soft(result.subtotal).toBeCloseTo(1000, 2);
  expect.soft(await invoiceCount()).toBe(before + 1);

  const untouched = await pool.query('SELECT status, invoice_id FROM time_entries WHERE id=$1', [theirs]);
  expect.soft(untouched.rows[0].status).toBe('approved');
  expect(untouched.rows[0].invoice_id).toBeNull();
});

it('renumbers past a legacy invoice holding the number the sequence is about to issue', async () => {
  const entry = await seedEntry(crypto.randomUUID());
  const peek = await pool.query(
    "SELECT prefix, next_number, padding FROM company_document_numbers WHERE company_id=$1 AND document_type='customer_invoice'",
    [company]);
  const { prefix, next_number, padding } = peek.rows[0];
  const taken = `${prefix}${String(Number(next_number)).padStart(Number(padding), '0')}`;
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,
                                   subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,$4,'2026-01-01',1,15,0,1,'draft',$5)`,
    [crypto.randomUUID(), company, taken, customer, user]);

  // The old loop retried on a message containing "unique" with no savepoint, so
  // the 23505 aborted the transaction and the retry died on 25P02 instead.
  const made = await inTx(() => generateWipInvoice(company, user, {
    practiceClientId: practiceClient, timeEntryIds: [entry],
  }));
  expect.soft(made.invoiceNumber).not.toBe(taken);
  const all = await pool.query(
    'SELECT invoice_number FROM customer_invoices WHERE company_id=$1', [company]);
  const numbers = all.rows.map((r: { invoice_number: string }) => String(r.invoice_number));
  expect(new Set(numbers).size).toBe(numbers.length);
});
