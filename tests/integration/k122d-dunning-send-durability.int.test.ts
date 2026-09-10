/**
 * K-122 round-4 review — M-2, M-5 and L-4.
 *
 * M-2: resolving a dispute "with credit" closes the dispute and leaves an
 * UNAPPROVED draft credit note — nothing posts to the GL, nothing is applied
 * to the invoice. The cron's dispute gate only skipped `status = 'open'`, so
 * the customer whose dispute was just agreed got the next escalation email for
 * the full amount the following morning.
 *
 * M-5: sendDunning dispatched the email and only then wrote its evidence row.
 * Inside the per-invoice savepoint an evidence failure rolled the dunning_sends
 * row back too: the customer has the email, the database has no record of it,
 * and the cron's "no existing send" gate re-sends the same escalation tomorrow.
 *
 * L-4: with no portal base URL configured the rendered body carries
 * '(portal link unavailable)' and was emailed, recorded as 'sent'.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

/** Set to a company id to make that company's captured_documents INSERT fail. */
let poisonEvidenceFor: string | null = null;
/** Set to a company id to make that company's email_status UPDATE fail. */
let poisonStatusFor: string | null = null;

vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (
      poisonEvidenceFor &&
      /INSERT\s+INTO\s+captured_documents/.test(text) &&
      values.includes(poisonEvidenceFor)
    ) {
      poisonEvidenceFor = null;
      // A genuine server-side error on the transaction's own connection.
      return original.sql`SELECT 1 / 0 AS boom`;
    }
    if (
      poisonStatusFor &&
      /UPDATE\s+dunning_sends\s+SET\s+email_status/.test(text) &&
      values.includes(poisonStatusFor)
    ) {
      poisonStatusFor = null;
      return original.sql`SELECT 1 / 0 AS boom`;
    }
    return original.sql(strings, ...values);
  };
  // Carry the real tagged template's own properties across; a bare arrow
  // function silently drops sql.transaction / sql.unsafe / sql.query.
  Object.assign(sql, {
    transaction: original.sql.transaction,
    unsafe: original.sql.unsafe,
    query: original.sql.query,
  });
  return { ...original, sql };
});

vi.mock('../../src/modules/accounting/services/core/emailService', () => ({
  sendEmail: async () => ({ success: true }),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const template = crypto.randomUUID();
const disputed = crypto.randomUUID(), plain = crypto.randomUUID();
const statusPoisoned = crypto.randomUUID();
const dispute = crypto.randomUUID(), creditNote = crypto.randomUUID();

async function makeInvoice(id: string, number: string, dueDate = '2026-01-31') {
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,$4,'2026-01-01',$6,1000,150,1150,'approved',$5)`,
    [id, company, number, customer, user, dueDate]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K122d fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,email) VALUES($1,$2,$3,$4)',
    [customer, company, 'K122d customer', 'k122d@test.local']);
  await makeInvoice(disputed, 'K122D-INV-1-DISPUTED');
  await makeInvoice(plain, 'K122D-INV-2-PLAIN');
  // Not yet due, so the cron never picks it up and the two cron assertions
  // above keep counting only INV-1/INV-2. This test drives sendDunning directly.
  await makeInvoice(statusPoisoned, 'K122D-INV-3-STATUS', '2026-12-31');
  await pool.query(
    `INSERT INTO dunning_templates(id,company_id,name,days_overdue_min,subject_template,body_template)
     VALUES($1,$2,'K122d reminder',1,'Invoice {{invoice_number}} is overdue','Pay online at {{portal_link}}')`,
    [template, company]);
  await pool.query(
    'INSERT INTO dunning_settings(company_id,auto_send_enabled,min_outstanding_zar) VALUES($1,true,0)',
    [company]);
  // A dispute resolved WITH credit, whose credit note is still a draft: the
  // amount was agreed but nothing has posted or been applied.
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,type,client_id,customer_invoice_id,credit_date,reason,subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'customer',$3,$4,'2026-02-01','K122d dispute credit',86.96,15,13.04,100,'draft',$5)`,
    [creditNote, company, customer, disputed, user]);
  await pool.query(
    `INSERT INTO customer_invoice_disputes(id,company_id,customer_invoice_id,reason,raised_by,disputed_amount,status,resolution_mode,credit_note_id,resolved_at,resolved_by)
     VALUES($1,$2,$3,'K122d agreed dispute',$4,100,'resolved','resolve_with_credit',$5,NOW(),$6)`,
    [dispute, company, disputed, user, creditNote, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_disputes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
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

const MONDAY = new Date('2026-03-02T09:00:00Z');
const PORTAL = 'https://app.isaflow.co.za';

it('does not chase an invoice whose dispute was resolved with a still-draft credit note', async () => {
  const { runDunningCron } =
    await import('../../src/modules/accounting/services/ar/dunningCronService');

  const result = await runDunningCron({ companyId: company, portalBaseUrl: PORTAL, now: MONDAY });
  expect(result.sent).toBe(1);
  expect(result.skipped).toBe(1);

  const { rows } = await pool.query(
    'SELECT customer_invoice_id FROM dunning_sends WHERE company_id=$1', [company]);
  expect(rows.map(r => r.customer_invoice_id)).toEqual([plain]);
});

it('resumes chasing once that credit note is approved and the amount is really credited', async () => {
  const { runDunningCron } =
    await import('../../src/modules/accounting/services/ar/dunningCronService');
  await pool.query("UPDATE credit_notes SET status='approved' WHERE id=$1", [creditNote]);
  // Clear the earlier run so the cool-off and same-template gates do not decide
  // this one for us.
  await pool.query('DELETE FROM dunning_sends WHERE company_id=$1', [company]);

  const result = await runDunningCron({ companyId: company, portalBaseUrl: PORTAL, now: MONDAY });
  expect(result.skipped).toBe(0);
  expect(result.sent).toBe(2);

  await pool.query("UPDATE credit_notes SET status='draft' WHERE id=$1", [creditNote]);
  await pool.query('DELETE FROM dunning_sends WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
});

it('refuses to send when the rendered body still carries the portal-link placeholder', async () => {
  const { sendDunning } = await import('../../src/modules/accounting/services/ar/dunningService');

  await expect(sendDunning({
    companyId: company, templateId: template, invoiceId: plain, // no portalBaseUrl
  })).rejects.toThrow(/portal link could not be resolved/);

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM dunning_sends WHERE company_id=$1', [company]);
  expect(rows[0].n).toBe(0);
});

it('keeps the record of a delivered email when the evidence row fails', async () => {
  const { als } = await import('../../src/lib/als');
  const { sql } = await import('../../src/lib/neon');
  const { sendDunning } = await import('../../src/modules/accounting/services/ar/dunningService');

  poisonEvidenceFor = company;
  const client = await pool.connect();
  let afterRows: unknown[];
  try {
    await client.query('BEGIN');
    afterRows = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      async () => {
        await sendDunning({
          companyId: company, templateId: template, invoiceId: plain, portalBaseUrl: PORTAL,
        });
        // The statement a handler would run next. On an aborted transaction
        // this raises 25P02 instead of returning a row.
        return (await sql`SELECT 1 AS still_alive`) as unknown[];
      },
    );
    await client.query('COMMIT');
    client.release();
  } catch (err) {
    // Never hand an aborted connection back to the pool.
    client.release(true);
    throw err;
  }

  expect(afterRows).toHaveLength(1);

  // The email left the building, so the send is recorded — with no evidence
  // document, which is the part that failed.
  const { rows } = await pool.query(
    `SELECT email_status, source_document_id FROM dunning_sends
      WHERE company_id=$1 AND customer_invoice_id=$2`, [company, plain]);
  expect(rows).toHaveLength(1);
  expect(rows[0].email_status).toBe('sent');
  expect(rows[0].source_document_id).toBeNull();
});

// Round-5 LOW-2: the email_status UPDATE is itself after the dispatch and can
// itself fail. Unsavepointed, a PG error there propagated and took the whole
// dunning_sends row with it — the customer keeps the email, the database
// forgets it, and the cron's "no existing send" gate re-sends the same
// escalation next run. That is the re-send the ordering above exists to
// prevent, so the UPDATE gets its own savepoint: the row survives as 'pending'.
it('keeps the send row when the email_status UPDATE itself fails', async () => {
  const { als } = await import('../../src/lib/als');
  const { sql } = await import('../../src/lib/neon');
  const { sendDunning } = await import('../../src/modules/accounting/services/ar/dunningService');

  poisonStatusFor = company;
  const client = await pool.connect();
  let afterRows: unknown[];
  try {
    await client.query('BEGIN');
    afterRows = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      async () => {
        await sendDunning({
          companyId: company, templateId: template, invoiceId: statusPoisoned, portalBaseUrl: PORTAL,
        });
        return (await sql`SELECT 1 AS still_alive`) as unknown[];
      },
    );
    await client.query('COMMIT');
    client.release();
  } catch (err) {
    client.release(true);
    throw err;
  }

  // The transaction is still usable: the failure was rolled back to its own
  // savepoint, not left to abort the connection with 25P02.
  expect(afterRows).toHaveLength(1);

  const { rows } = await pool.query(
    `SELECT email_status FROM dunning_sends
      WHERE company_id=$1 AND customer_invoice_id=$2`, [company, statusPoisoned]);
  expect(rows).toHaveLength(1);
  // 'pending' is an honest unknown — and enough for the re-send gate.
  expect(rows[0].email_status).not.toBe('sent');
});
