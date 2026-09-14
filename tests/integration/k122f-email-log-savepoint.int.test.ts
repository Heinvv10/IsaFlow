/**
 * K-122 round-5 review, MEDIUM-1 — the email_log write must not be able to
 * lose the record of an email that was already delivered.
 *
 * M-5 moved the `dunning_sends.email_status` UPDATE to immediately after the
 * dispatch, and put the evidence row in its own savepoint. But the statement
 * BETWEEN the dispatch and that UPDATE — `sendEmail`'s `email_log` INSERT —
 * ran on the same transaction, un-awaited and un-savepointed. A failure there
 * aborts the transaction, so the very next statement (the status UPDATE) dies
 * with 25P02, the cron's per-invoice savepoint rolls the `dunning_sends` row
 * away, and tomorrow's run re-sends the same escalation to a customer who
 * already has it: the exact failure M-5 was raised to close, reached by a
 * different statement.
 *
 * Proved by outcome: with the email_log INSERT failing, the customer's email
 * still leaves, the send is still recorded as 'sent', and the transaction is
 * still executing statements afterwards.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

/** Flipped on for the one email_log INSERT that must fail. */
let poisonEmailLog = false;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (poisonEmailLog && /INSERT\s+INTO\s+email_log/.test(strings.join(' '))) {
      poisonEmailLog = false;
      // A genuine server-side error on the transaction's own connection.
      return original.sql`SELECT 1 / 0 AS boom`;
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, {
    transaction: original.sql.transaction,
    unsafe: original.sql.unsafe,
    query: original.sql.query,
  });
  return { ...original, sql };
});

const sent: { to: string }[] = [];
vi.mock('nodemailer', () => {
  const createTransport = () => ({
    sendMail: async (opts: { to: string }) => {
      sent.push({ to: opts.to });
      return { messageId: 'k122f-message-id' };
    },
  });
  return { createTransport, default: { createTransport } };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), template = crypto.randomUUID();

beforeAll(async () => {
  // sendEmail short-circuits without SMTP config, and never reaches the
  // dispatch this test is about.
  process.env.SMTP_HOST = 'smtp.test.local';
  process.env.SMTP_USER = 'k122f';
  process.env.SMTP_PASS = 'k122f';

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K122f fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,email) VALUES($1,$2,$3,$4)', [customer, company, 'K122f customer', 'k122f@test.local']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122F-INV',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [invoice, company, customer, user]);
  await pool.query(
    `INSERT INTO dunning_templates(id,company_id,name,days_overdue_min,subject_template,body_template)
     VALUES($1,$2,'K122f reminder',1,'Invoice {{invoice_number}} is overdue','Pay online at {{portal_link}}')`,
    [template, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM dunning_sends WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM email_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM dunning_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('keeps a delivered send recorded when the email_log write fails', async () => {
  const { als } = await import('../../src/lib/als');
  const { sql } = await import('../../src/lib/neon');
  const { sendDunning } = await import('../../src/modules/accounting/services/ar/dunningSend');

  poisonEmailLog = true;

  const client = await pool.connect();
  let result: Awaited<ReturnType<typeof sendDunning>>;
  let afterRows: unknown[];
  try {
    await client.query('BEGIN');
    ({ result, afterRows } = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      async () => {
        const r = await sendDunning({
          companyId: company, invoiceId: invoice, templateId: template,
          sentBy: user, triggerSource: 'manual',
          portalBaseUrl: 'https://app.isaflow.co.za',
        });
        // The statement a handler would run next. On an aborted transaction
        // this raises 25P02 instead of returning a row.
        const rows = await sql`SELECT 1 AS still_alive`;
        return { result: r, afterRows: rows as unknown[] };
      },
    ));
    await client.query('COMMIT');
    client.release();
  } catch (err) {
    client.release(true);
    throw err;
  }

  // The email really left.
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe('k122f@test.local');

  // …and the send says so, both in the return value and in the durable row.
  expect(result.emailStatus).toBe('sent');
  expect(afterRows).toHaveLength(1);

  const { rows } = await pool.query(
    'SELECT email_status, email_error FROM dunning_sends WHERE company_id=$1', [company]);
  expect(rows).toHaveLength(1);
  expect(rows[0].email_status).toBe('sent');
  expect(rows[0].email_error).toBeNull();

  // The audit row itself is the only casualty, which is the correct trade.
  const { rows: logRows } = await pool.query(
    'SELECT count(*)::int AS n FROM email_log WHERE company_id=$1', [company]);
  expect(logRows[0].n).toBe(0);
});

it('still writes the email_log row when nothing fails', async () => {
  const { als } = await import('../../src/lib/als');
  const { sendDunning } = await import('../../src/modules/accounting/services/ar/dunningSend');

  const second = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122F-INV-2',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [second, company, customer, user]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: user, companyId: company, claims: {} }, async () => {
      await sendDunning({
        companyId: company, invoiceId: second, templateId: template,
        sentBy: user, triggerSource: 'manual',
        portalBaseUrl: 'https://app.isaflow.co.za',
      });
    });
    await client.query('COMMIT');
    client.release();
  } catch (err) {
    client.release(true);
    throw err;
  }

  const { rows } = await pool.query(
    "SELECT status, recipient_email FROM email_log WHERE company_id=$1", [company]);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('sent');
  expect(rows[0].recipient_email).toBe('k122f@test.local');
});
