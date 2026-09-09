/**
 * K-013 — a recurring run mints an APPROVED invoice with no lines and no GL.
 *
 * generateInvoiceFromRecurring INSERTed a customer_invoices header directly at
 * status='approved' (recurringInvoiceService.ts:131-143), never calling
 * approveCustomerInvoice. It wrote no customer_invoice_items and posted no
 * journal, then advanced the schedule (:145-150). The canonical approve path
 * (customerInvoiceApprovalService.ts:133-142) posts DR AR / CR Revenue / CR VAT
 * on approve precisely because an approved invoice with a NULL
 * gl_journal_entry_id puts AR and the GL out of agreement by the invoice total.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { generateInvoiceFromRecurring } from '../../src/modules/accounting/services/ar/recurringInvoiceService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const other = crypto.randomUUID();
const template = crypto.randomUUID(), emptyTemplate = crypto.randomUUID();
const period = crypto.randomUUID();
const arAcc = crypto.randomUUID(), revAcc = crypto.randomUUID(), vatAcc = crypto.randomUUID();
let generated = '';

/**
 * Run inside a real request transaction, exactly as withAuth does. The service
 * now takes FOR UPDATE on the template and refuses without one, because outside
 * a transaction that lock is released the instant the SELECT returns.
 */
async function inTx<T>(fn: () => Promise<T>, keep = false): Promise<T> {
  const client: PoolClient = await pool.connect();
  const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
  try {
    await client.query('BEGIN');
    const out = await als.run(ctx, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    if (!keep) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'K013 recurring fixture', other, 'K013 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K013 customer']);
  await pool.query(
    "INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'K013 year',1,2026,'2026-01-01','2026-12-31','open')",
    [period, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES
      ($1,$4,'K1100','Accounts receivable','asset','receivable','debit',true,true),
      ($2,$4,'K4000','Sales','revenue','default_revenue','credit',true,true),
      ($3,$4,'K2200','VAT output','liability','vat_output','credit',true,true)`,
    [arAcc, revAcc, vatAcc, company]);
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 monthly retainer',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Monthly retainer',
      $4::jsonb,1000,15,150,1150,$5,'active')`,
    [template, company, customer, JSON.stringify([{ description: 'Monthly retainer', quantity: 1, unitPrice: 1000 }]), user]);
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 empty template',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Empty',
      '[]'::jsonb,0,15,0,0,$4,'active')`,
    [emptyTemplate, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM recurring_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('generates an approved invoice that carries its lines and its GL journal', async () => {
  generated = await inTx(() => generateInvoiceFromRecurring(company, template, user));

  const inv = (await pool.query(
    'SELECT status, total_amount::text AS total, gl_journal_entry_id FROM customer_invoices WHERE id=$1', [generated])).rows[0];
  expect(inv.status).toBe('approved');
  expect(inv.total).toBe('1150.00');

  const items = await pool.query(
    'SELECT count(*)::int AS n, sum(amount)::text AS total FROM customer_invoice_items WHERE invoice_id=$1', [generated]);
  expect(items.rows[0].n).toBe(1);
  expect(Number(items.rows[0].total)).toBe(1000);

  expect(inv.gl_journal_entry_id).not.toBeNull();
  const posted = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND status='posted'", [company]);
  expect(posted.rows[0].n).toBe(1);

  // The journal balances AND its receivable leg equals the invoice total.
  const lines = (await pool.query(
    `SELECT ga.account_subtype AS subtype, l.debit::float AS debit, l.credit::float AS credit
     FROM gl_journal_lines l JOIN gl_accounts ga ON ga.id = l.gl_account_id
     WHERE l.journal_entry_id=$1`, [inv.gl_journal_entry_id])).rows;
  const sum = (k: 'debit' | 'credit') => lines.reduce((s: number, r: Record<string, number>) => s + Number(r[k] || 0), 0);
  expect(sum('debit')).toBeCloseTo(sum('credit'), 2);
  expect(sum('debit')).toBeCloseTo(1150, 2);
  const receivable = lines.filter((r: { subtype: string }) => r.subtype === 'receivable');
  expect(receivable).toHaveLength(1);
  expect(Number(receivable[0].debit)).toBeCloseTo(1150, 2);
  expect(lines.find((r: { subtype: string }) => r.subtype === 'default_revenue').credit).toBeCloseTo(1000, 2);
  expect(lines.find((r: { subtype: string }) => r.subtype === 'vat_output').credit).toBeCloseTo(150, 2);

  // The schedule advanced only after the invoice really existed.
  const ri = (await pool.query(
    'SELECT run_count, next_run_date::text AS next FROM recurring_invoices WHERE id=$1', [template])).rows[0];
  expect(Number(ri.run_count)).toBe(1);
  const expected = (await pool.query(
    "SELECT to_char((CURRENT_DATE - INTERVAL '3 days' + INTERVAL '1 month')::date,'YYYY-MM-DD') AS d")).rows[0].d;
  expect(ri.next).toBe(expected);
});

it('refuses a template with no line items and leaves the schedule untouched', async () => {
  await expect(inTx(() => generateInvoiceFromRecurring(company, emptyTemplate, user))).rejects.toThrow(/no line items/);

  const n = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Empty'", [company]);
  expect(n.rows[0].n).toBe(0);
  const ri = (await pool.query('SELECT run_count, last_run_date FROM recurring_invoices WHERE id=$1', [emptyTemplate])).rows[0];
  expect(Number(ri.run_count)).toBe(0);
  expect(ri.last_run_date).toBeNull();
});

it('does not advance another tenant view of the template', async () => {
  await expect(inTx(() => generateInvoiceFromRecurring(other, template, user))).rejects.toThrow(/not found/i);
  const ri = (await pool.query('SELECT run_count FROM recurring_invoices WHERE id=$1', [template])).rows[0];
  expect(Number(ri.run_count)).toBe(1);
});

it('rolls the header back inside the request transaction when approval cannot post', async () => {
  // The batch runner catches per template and carries on, committing the shared
  // request transaction at the end. Deactivating the revenue role makes the
  // canonical approve path refuse; the savepoint must take the header and its
  // lines with it, so the surviving transaction holds nothing half-built.
  const t2 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 blocked',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Blocked',$4::jsonb,500,15,75,575,$5,'active')`,
    [t2, company, customer, JSON.stringify([{ description: 'Blocked line', quantity: 1, unitPrice: 500 }]), user]);
  await pool.query('UPDATE gl_accounts SET account_subtype=NULL WHERE id=$1', [revAcc]);
  clearSystemAccountCache(company);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
    await expect(als.run(ctx, () => generateInvoiceFromRecurring(company, t2, user))).rejects.toThrow();

    // The transaction is still usable — the caught failure did not poison it —
    // and it carries no trace of the blocked invoice.
    const left = await client.query(
      "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Blocked'", [company]);
    expect(left.rows[0].n).toBe(0);
    const orphanItems = await client.query(
      `SELECT count(*)::int AS n FROM customer_invoice_items i
       WHERE NOT EXISTS (SELECT 1 FROM customer_invoices ci WHERE ci.id = i.invoice_id)`);
    expect(orphanItems.rows[0].n).toBe(0);
    await client.query('COMMIT');
  } finally {
    client.release();
    await pool.query("UPDATE gl_accounts SET account_subtype='default_revenue' WHERE id=$1", [revAcc]);
    clearSystemAccountCache(company);
  }

  // Committed: nothing persisted, and the schedule never advanced.
  const after = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Blocked'", [company]);
  expect(after.rows[0].n).toBe(0);
  const ri = (await pool.query('SELECT run_count FROM recurring_invoices WHERE id=$1', [t2])).rows[0];
  expect(Number(ri.run_count)).toBe(0);
});

it('refuses a repeat run of a template already run today, so no second journal is posted', async () => {
  // Review H1: before the canonical approve path was wired in, a repeat POST
  // minted a duplicate header with no ledger effect. Now it would post a full
  // DR AR / CR Revenue / CR VAT journal and skip a period.
  const before = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND status='posted'", [company]);

  await expect(inTx(() => generateInvoiceFromRecurring(company, template, user)))
    .rejects.toThrow(/not due until/);

  const after = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND status='posted'", [company]);
  expect(after.rows[0].n).toBe(before.rows[0].n);
  const invoices = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Monthly retainer'", [company]);
  expect(invoices.rows[0].n).toBe(1);
  const ri = (await pool.query('SELECT run_count FROM recurring_invoices WHERE id=$1', [template])).rows[0];
  expect(Number(ri.run_count)).toBe(1);
});

it('serialises two concurrent runs of one template on the template row lock', async () => {
  // Review H1: the check "active and due" is a check-then-act. Session B must
  // block on A's FOR UPDATE and then read the settled next_run_date, rather
  // than colliding by luck on the invoice-number unique index.
  const t3 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 race',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Race',$4::jsonb,200,15,30,230,$5,'active')`,
    [t3, company, customer, JSON.stringify([{ description: 'Race line', quantity: 1, unitPrice: 200 }]), user]);

  const a = await pool.connect(), b = await pool.connect();
  const ctxFor = (client: PoolClient) =>
    ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);
  try {
    await a.query('BEGIN');
    await als.run(ctxFor(a), () => generateInvoiceFromRecurring(company, t3, user));

    // B starts while A still holds the row: it must block, not proceed.
    await b.query('BEGIN');
    const attempt = als.run(ctxFor(b), () => generateInvoiceFromRecurring(company, t3, user));
    let settled = false;
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    await a.query('COMMIT');
    await expect(attempt).rejects.toThrow(/not due until/);
    await b.query('ROLLBACK');
  } finally {
    a.release(); b.release();
  }

  const posted = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Race'", [company]);
  expect(posted.rows[0].n).toBe(1);
});

it('refuses a template whose stored totals disagree with its lines', async () => {
  // Review M3: the journal is posted from the header while the lines are
  // computed independently. A template edited on one side only must be refused,
  // not silently turned into an invoice whose detail does not foot.
  const t4 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 drifted',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Drifted',$4::jsonb,9000,15,1350,10350,$5,'active')`,
    [t4, company, customer, JSON.stringify([{ description: 'Drifted line', quantity: 1, unitPrice: 100 }]), user]);

  await expect(inTx(() => generateInvoiceFromRecurring(company, t4, user)))
    .rejects.toThrow(/totals disagree with its lines/);
  const n = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Drifted'", [company]);
  expect(n.rows[0].n).toBe(0);
});

it('writes a header that foots against its own lines and its journal', async () => {
  // Review M3: header totals are derived from the lines, so sum(items) + VAT
  // equals total_amount equals the receivable debit, by construction.
  const t5 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 multi',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Multi',$4::jsonb,433.32,15,65,498.32,$5,'active')`,
    [t5, company, customer, JSON.stringify([
      { description: 'A', quantity: 3, unitPrice: 33.333 },
      { description: 'B', quantity: 1, unitPrice: 333.33 },
    ]), user]);

  const id = await inTx(() => generateInvoiceFromRecurring(company, t5, user));
  const inv = (await pool.query(
    'SELECT subtotal::float AS subtotal, tax_amount::float AS tax, total_amount::float AS total, gl_journal_entry_id FROM customer_invoices WHERE id=$1',
    [id])).rows[0];
  const items = (await pool.query(
    'SELECT sum(amount)::float AS total, count(*)::int AS n FROM customer_invoice_items WHERE invoice_id=$1', [id])).rows[0];
  expect(items.n).toBe(2);
  expect(items.total).toBeCloseTo(inv.subtotal, 2);
  expect(inv.subtotal + inv.tax).toBeCloseTo(inv.total, 2);
  const legs = (await pool.query(
    `SELECT ga.account_subtype AS subtype, l.debit::float AS debit FROM gl_journal_lines l
     JOIN gl_accounts ga ON ga.id = l.gl_account_id WHERE l.journal_entry_id=$1`, [inv.gl_journal_entry_id])).rows;
  const ar = legs.find((r: { subtype: string }) => r.subtype === 'receivable');
  expect(ar.debit).toBeCloseTo(inv.total, 2);
});

it('rolls back only the failing template when several run in one transaction', async () => {
  // Review L2: savepoint names are sequenced, so the second generation's
  // ROLLBACK TO cannot unwind the first one's subtransaction.
  const ok = crypto.randomUUID(), bad = crypto.randomUUID();
  for (const [id, name, lines] of [
    [ok, 'SeqOK', [{ description: 'Seq ok', quantity: 1, unitPrice: 100 }]],
    [bad, 'SeqBad', []],
  ] as [string, string, unknown[]][]) {
    await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
      VALUES($1,$2,$3,$4,'monthly',CURRENT_DATE - INTERVAL '3 days',$3,$5::jsonb,100,15,15,115,$6,'active')`,
      [id, company, name, customer, JSON.stringify(lines), user]);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
    await als.run(ctx, async () => {
      await generateInvoiceFromRecurring(company, ok, user);
      await expect(generateInvoiceFromRecurring(company, bad, user)).rejects.toThrow(/no line items/);
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // The good invoice survived the second template's failure, and its schedule
  // advance (now inside the same savepoint) survived with it.
  const kept = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='SeqOK'", [company]);
  expect(kept.rows[0].n).toBe(1);
  const ri = (await pool.query('SELECT run_count FROM recurring_invoices WHERE id=$1', [ok])).rows[0];
  expect(Number(ri.run_count)).toBe(1);
});

it('does not advance the schedule when the schedule UPDATE is rolled back with its invoice', async () => {
  // Review M1: the schedule advance now sits INSIDE the savepoint, so a
  // template that fails at approval leaves neither an invoice nor a moved
  // next_run_date in the surviving transaction.
  const t6 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 sched',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Sched',$4::jsonb,400,15,60,460,$5,'active')`,
    [t6, company, customer, JSON.stringify([{ description: 'Sched line', quantity: 1, unitPrice: 400 }]), user]);
  await pool.query('UPDATE gl_accounts SET account_subtype=NULL WHERE id=$1', [revAcc]);
  clearSystemAccountCache(company);
  try {
    await expect(inTx(() => generateInvoiceFromRecurring(company, t6, user))).rejects.toThrow();
  } finally {
    await pool.query("UPDATE gl_accounts SET account_subtype='default_revenue' WHERE id=$1", [revAcc]);
    clearSystemAccountCache(company);
  }
  const ri = (await pool.query(
    'SELECT run_count, next_run_date::text AS next, last_run_date FROM recurring_invoices WHERE id=$1', [t6])).rows[0];
  expect(Number(ri.run_count)).toBe(0);
  const untouched = (await pool.query(
    "SELECT to_char((CURRENT_DATE - INTERVAL '3 days')::date,'YYYY-MM-DD') AS d")).rows[0].d;
  expect(ri.next).toBe(untouched);
  expect(ri.last_run_date).toBeNull();
});

it('refuses to run at all outside a request transaction, rather than locking nothing', async () => {
  const t7 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
    VALUES($1,$2,'K013 notx',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','NoTx',$4::jsonb,100,15,15,115,$5,'active')`,
    [t7, company, customer, JSON.stringify([{ description: 'NoTx line', quantity: 1, unitPrice: 100 }]), user]);
  await expect(generateInvoiceFromRecurring(company, t7, user)).rejects.toThrow(/requires a request transaction/);
  const n = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='NoTx'", [company]);
  expect(n.rows[0].n).toBe(0);
});

it('rolls the invoice back when the schedule advance itself fails', async () => {
  // Review M1: the schedule UPDATE used to sit OUTSIDE the savepoint. The batch
  // runner catches per template and answers 200, which withAuth COMMITs — so an
  // UPDATE that raised would leave a fully posted invoice behind while its
  // template never advanced, and report the id as generated. run_count at the
  // integer ceiling makes `run_count + 1` raise deterministically.
  const t8 = crypto.randomUUID();
  await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,description,line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status,run_count)
    VALUES($1,$2,'K013 overflow',$3,'monthly',CURRENT_DATE - INTERVAL '3 days','Overflow',$4::jsonb,300,15,45,345,$5,'active',2147483647)`,
    [t8, company, customer, JSON.stringify([{ description: 'Overflow line', quantity: 1, unitPrice: 300 }]), user]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
    await expect(als.run(ctx, () => generateInvoiceFromRecurring(company, t8, user)))
      .rejects.toThrow(/out of range/);

    // The savepoint took the invoice, its lines and its journal with it, and
    // left the transaction usable — so the run can be COMMITted, not aborted.
    const left = await client.query(
      "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Overflow'", [company]);
    expect(left.rows[0].n).toBe(0);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const after = await pool.query(
    "SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND notes='Overflow'", [company]);
  expect(after.rows[0].n).toBe(0);
});
