/**
 * K-122 (H3) — a PostgreSQL error raised while sending one invoice must not
 * poison the request transaction the rest of the run shares.
 *
 * renderTemplate now issues SQL (the portal_token mint), and sendDunning writes
 * dunning_sends and captured_documents. withAuth runs the whole handler inside
 * ONE transaction (bearerPipeline.ts:243 enters the ALS with a BEGUN client),
 * so any PG error aborts it: every later statement fails with 25P02 until the
 * transaction ends. The per-invoice catch in runDunningCron would then convert
 * one transient lock into a failure of every remaining invoice in the run, and
 * of whatever the handler does after it.
 *
 * Catching is not isolation — only a SAVEPOINT restores a usable transaction.
 * This test drives the real cron inside a real transaction, raises a real PG
 * error (22012) inside the first invoice's send, and asserts by OUTCOME: the
 * second invoice still sends, and the transaction still executes statements.
 *
 * No production caller enters an ALS transaction today — the cron route
 * (pages/api/cron/dunning-send.ts) is wrapped in withErrorHandler only, so
 * withSavepoint degrades to a plain call there. The transaction is built by
 * hand below so the invariant is guarded for the in-request caller (any
 * withAuth handler that sends dunning) the moment one exists.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

/** Invoice whose dunning_sends INSERT is replaced by a failing statement. */
let poisonInvoiceId: string | null = null;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (
      poisonInvoiceId &&
      /INSERT\s+INTO\s+dunning_sends/.test(text) &&
      values.includes(poisonInvoiceId)
    ) {
      poisonInvoiceId = null;
      // A genuine server-side error on the transaction's own connection —
      // division_by_zero stands in for the lock_timeout / deadlock / statement
      // timeout this UPDATE-and-INSERT path can actually raise.
      return original.sql`SELECT 1 / 0 AS boom`;
    }
    return original.sql(strings, ...values);
  };
  return { ...original, sql };
});

vi.mock('../../src/modules/accounting/services/core/emailService', () => ({
  sendEmail: async () => ({ success: true }),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const poisoned = crypto.randomUUID(), healthy = crypto.randomUUID(), template = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K122c fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,email) VALUES($1,$2,$3,$4)', [customer, company, 'K122c customer', 'k122c@test.local']);
  for (const [id, number] of [[poisoned, 'K122C-INV-1-POISON'], [healthy, 'K122C-INV-2-OK']] as const) {
    await pool.query(
      `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,$4,'2026-01-01','2026-01-31',1000,150,1150,'approved',$5)`,
      [id, company, number, customer, user]);
  }
  await pool.query(
    `INSERT INTO dunning_templates(id,company_id,name,days_overdue_min,subject_template,body_template)
     VALUES($1,$2,'K122c reminder',1,'Invoice {{invoice_number}} is overdue','Pay online at {{portal_link}}')`,
    [template, company]);
  await pool.query(
    'INSERT INTO dunning_settings(company_id,auto_send_enabled,min_outstanding_zar) VALUES($1,true,0)',
    [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM dunning_sends WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM dunning_settings WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM dunning_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('rolls one failing invoice back to its savepoint and leaves the transaction usable', async () => {
  const { als } = await import('../../src/lib/als');
  const { sql } = await import('../../src/lib/neon');
  const { runDunningCron } =
    await import('../../src/modules/accounting/services/ar/dunningCronService');

  poisonInvoiceId = poisoned;

  const client = await pool.connect();
  let result: Awaited<ReturnType<typeof runDunningCron>>;
  let afterRunRows: unknown[];
  try {
    await client.query('BEGIN');
    ({ result, afterRunRows } = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      async () => {
        // A Monday, so the weekend guard does not short-circuit the run.
        const r = await runDunningCron({ companyId: company, portalBaseUrl: 'https://app.isaflow.co.za', now: new Date('2026-03-02T09:00:00Z') });
        // The statement a handler would run after the cron. On an aborted
        // transaction this raises 25P02 instead of returning a row.
        const rows = await sql`SELECT 1 AS still_alive`;
        return { result: r, afterRunRows: rows as unknown[] };
      },
    ));
    await client.query('COMMIT');
    client.release();
  } catch (err) {
    // Never hand an aborted connection back to the pool: the next checkout
    // would get a bare 25P02 on an unrelated statement, in this file or the
    // next. Destroy it instead of releasing it.
    client.release(true);
    throw err;
  }

  // The poisoned invoice failed, and its failure is reported as its own.
  expect(result.failed).toBe(1);
  expect(result.errors.join(' ')).toMatch(new RegExp(poisoned));

  // The invoice AFTER it still sent — the failure did not cascade. The cron
  // orders candidates by invoice_number, so K122C-INV-1-POISON is genuinely
  // processed before K122C-INV-2-OK rather than by luck of heap order.
  expect(result.sent).toBe(1);
  expect(result.errors.join(' ')).not.toMatch(/25P02|current transaction is aborted/i);

  // And the transaction was still executing statements when the cron returned.
  expect(afterRunRows).toHaveLength(1);

  // Outcome in the database: exactly the healthy invoice has a send row, and
  // the poisoned invoice's partial writes were rolled back with its savepoint.
  const { rows } = await pool.query(
    'SELECT customer_invoice_id FROM dunning_sends WHERE company_id=$1', [company]);
  expect(rows.map(r => r.customer_invoice_id)).toEqual([healthy]);

  const { rows: tokens } = await pool.query(
    'SELECT portal_token FROM customer_invoices WHERE id=$1', [poisoned]);
  expect(tokens[0].portal_token).toBeNull();
});
