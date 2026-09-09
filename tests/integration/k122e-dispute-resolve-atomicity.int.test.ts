/**
 * K-122 round-5 review, HIGH-1 — the claim and the credit note must share one
 * fate.
 *
 * The round-4 fix moved the status-predicated claim UPDATE in FRONT of
 * `createCreditNote` (correctly — it is what stops two concurrent resolves both
 * raising a note). But `createCreditNote` throws the bare literal 'Not found'
 * when a link target is gone, the resolve route matched `/not found/i` and
 * answered 400, and `withAuth` COMMITs on anything below 500. The dispute was
 * left permanently `status='resolved'`, `credit_note_id=NULL`, with no credit
 * note behind it and no way to retry: the claim predicate wants `status='open'`.
 *
 * Two changes are proved here, by OUTCOME on a real transaction:
 *   1. resolveDispute runs claim + credit note + link inside ONE savepoint, so
 *      a failure anywhere rolls the claim back and the dispute stays open.
 *   2. the errors it raises itself are typed (ArRequestError). Anything else —
 *      including createCreditNote's 'Not found' — is NOT one, so the route
 *      lets it reach withAuth as a 5xx and the transaction rolls back.
 *
 * Driven inside a hand-built ALS transaction because that is the production
 * shape (withAuth) and the shape where a committed half-state is possible.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ArRequestError } from '../../src/modules/accounting/services/ar/arErrors';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), dispute = crypto.randomUUID();
const rateInvoice = crypto.randomUUID(), rateDispute = crypto.randomUUID();

/** Run `fn` the way withAuth does: one BEGIN/COMMIT, inside the ALS store. */
async function inRequestTx<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('../../src/lib/als');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: company, claims: {} }, fn);
    await client.query('COMMIT');
    client.release();
    return out;
  } catch (err) {
    // Never hand a possibly-aborted connection back to the pool.
    client.release(true);
    throw err;
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K122e fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K122e customer']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122E-INV',$3,$3,'2026-01-01','2026-01-31',1000,15,150,1150,'sent',$4)`,
    [invoice, company, customer, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
     VALUES($1,$2,$3,'K122e disputed line',$4,115,'open')`,
    [dispute, company, invoice, user]);
  // An invoice whose amounts admit no VAT rate: tax with a zero subtotal makes
  // the derived rate 0, which would book the whole gross to revenue.
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122E-INV-RATE',$3,$3,'2026-01-01','2026-01-31',0,15,150,150,'sent',$4)`,
    [rateInvoice, company, customer, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status)
     VALUES($1,$2,$3,'K122e underivable rate',$4,50,'open')`,
    [rateDispute, company, rateInvoice, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_disputes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('leaves the dispute retryable when createCreditNote fails, and does not classify it as a 4xx', async () => {
  const { resolveDispute } = await import('../../src/modules/accounting/services/ar/disputeService');

  // The failure the reviewer proved: the customer is gone, so
  // validateCreditNoteLinks returns the bare literal 'Not found'.
  await pool.query('UPDATE customers SET deleted_at = NOW() WHERE id=$1', [customer]);

  const thrown = await inRequestTx(async () =>
    resolveDispute(company, dispute, user, {
      mode: 'resolve_with_credit', creditDate: '2026-02-01',
    }).then(() => null, (err: unknown) => err),
  );

  expect(String((thrown as Error).message)).toMatch(/not found/i);
  // Not the service's own refusal → the route rethrows → withAuth sees a 5xx
  // and ROLLBACKs. Were this an ArRequestError the route would answer 400,
  // which withAuth COMMITs.
  expect(thrown).not.toBeInstanceOf(ArRequestError);

  // The transaction COMMITTED (the throw was caught inside it), so this is the
  // durable state a 400 would have left behind. The savepoint is what makes it
  // right: no claim, no orphan.
  const { rows: d } = await pool.query(
    'SELECT status, resolution_mode, credit_note_id FROM customer_invoice_disputes WHERE id=$1',
    [dispute]);
  expect(d[0].status).toBe('open');
  expect(d[0].resolution_mode).toBeNull();
  expect(d[0].credit_note_id).toBeNull();

  const { rows: cn } = await pool.query(
    'SELECT count(*)::int AS n FROM credit_notes WHERE company_id=$1', [company]);
  expect(cn[0].n).toBe(0);

  // And it is genuinely retryable once the cause is fixed.
  await pool.query('UPDATE customers SET deleted_at = NULL WHERE id=$1', [customer]);
  const resolved = await inRequestTx(async () =>
    resolveDispute(company, dispute, user, {
      mode: 'resolve_with_credit', creditDate: '2026-02-01',
    }),
  );
  expect(resolved.status).toBe('resolved');
  expect(resolved.creditNoteId).not.toBeNull();

  const { rows: note } = await pool.query(
    'SELECT subtotal, tax_rate, tax_amount, total_amount FROM credit_notes WHERE id=$1',
    [resolved.creditNoteId]);
  expect(note).toHaveLength(1);
  // The invoice's own 15% reconciles with its amounts, so that exact rate is
  // stamped rather than a derived one, and the halves still foot to the gross.
  expect(Number(note[0].tax_rate)).toBeCloseTo(15, 2);
  expect(Number(note[0].subtotal) + Number(note[0].tax_amount)).toBeCloseTo(115, 2);
  expect(Number(note[0].total_amount)).toBeCloseTo(115, 2);
});

it('rolls the claim back even when the refusal IS a 4xx the route commits', async () => {
  const { resolveDispute } = await import('../../src/modules/accounting/services/ar/disputeService');

  const thrown = await inRequestTx(async () =>
    resolveDispute(company, rateDispute, user, {
      mode: 'resolve_with_credit', creditDate: '2026-02-01',
    }).then(() => null, (err: unknown) => err),
  );

  // This one IS the service's own refusal: the route answers 400 and withAuth
  // COMMITs. The savepoint is the only thing standing between that and a
  // dispute claimed as resolved with nothing behind it.
  expect(thrown).toBeInstanceOf(ArRequestError);
  expect((thrown as ArRequestError).status).toBe(400);

  const { rows } = await pool.query(
    'SELECT status, resolution_mode FROM customer_invoice_disputes WHERE id=$1', [rateDispute]);
  expect(rows[0].status).toBe('open');
  expect(rows[0].resolution_mode).toBeNull();
});

it('types the not-open refusal so the route can answer 400 without committing a claim', async () => {
  const { resolveDispute } = await import('../../src/modules/accounting/services/ar/disputeService');

  // `dispute` was resolved by the first test; resolving it again must refuse.
  const thrown = await inRequestTx(async () =>
    resolveDispute(company, dispute, user, { mode: 'resolve_no_credit' })
      .then(() => null, (err: unknown) => err),
  );
  expect(thrown).toBeInstanceOf(ArRequestError);
  expect((thrown as ArRequestError).code).toBe('DISPUTE_NOT_OPEN');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM credit_notes WHERE company_id=$1', [company]);
  expect(rows[0].n).toBe(1);
});
