/**
 * R-186: the archive skips customer invoices a Paystack payment request references.
 *
 * `paystack_payment_requests.customer_invoice_id` is ON DELETE SET NULL and
 * `paystack_pr_invoice_has_invoice` requires it for purpose 'customer_invoice',
 * so deleting such an invoice raises 23514 and the whole archive run rolls back.
 * Hein, 2026-10-03: skip those invoices (same company), report how many, and
 * leave the requests alone. The preview must predict the same skip.
 *
 * Invoices are paid or cancelled with no allocation row, so R-053 (a paid
 * invoice's allocation blocks the delete on 23503) stays out of reach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { previewArchive } from '@/modules/accounting/services/core/archiveQueryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const CUTOFF = '2005-01-01';
const OLD_DAY = '2001-01-01';
const user = randomUUID();
/** Company A: one referenced invoice, one free invoice. */
const coA = randomUUID();
/** Company B: its own referenced invoice, and a request pointing at company C's invoice. */
const coB = randomUUID();
/** Company C: one invoice referenced only by company B's request. */
const coC = randomUUID();
const companies = [coA, coB, coC];
const inv = { aRef: randomUUID(), aFree: randomUUID(), bRef: randomUUID(), c: randomUUID() };
const req = { a: randomUUID(), b: randomUUID(), bToC: randomUUID() };

async function drive<T>(companyId: string, fn: () => Promise<T>, commit: boolean): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId, claims: {} }, fn);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function addInvoice(companyId: string, id: string, status: 'paid' | 'cancelled'): Promise<void> {
  const customer = randomUUID();
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, companyId, `R186 ${id.slice(0, 8)}`]);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,created_by,
       invoice_date,total_amount,amount_paid,status)
     VALUES($1,$2,$3,$4,$5,$6,100,$7,$8)`,
    [id, companyId, `R186-${id.slice(0, 8)}`, customer, user, OLD_DAY, status === 'paid' ? 100 : 0, status],
  );
}

async function addRequest(id: string, companyId: string, invoiceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO paystack_payment_requests(id,company_id,purpose,customer_invoice_id,paystack_reference,amount_cents,status)
     VALUES($1,$2,'customer_invoice',$3,$4,10000,'completed')`,
    [id, companyId, invoiceId, `r186-${randomUUID()}`],
  );
}

async function count(sqlText: string, params: unknown[]): Promise<number> {
  return (await pool.query(sqlText, params)).rows[0]!.n as number;
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [i, id] of companies.entries()) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `R186 archive company ${i}`]);
  }
  await addInvoice(coA, inv.aRef, 'cancelled');
  await addInvoice(coA, inv.aFree, 'paid');
  await addInvoice(coB, inv.bRef, 'paid');
  await addInvoice(coC, inv.c, 'cancelled');
  await addRequest(req.a, coA, inv.aRef);
  await addRequest(req.b, coB, inv.bRef);
  // Cross-tenant: the FK is single-column, so nothing stops a request in B
  // naming C's invoice. It must not decide what C's archive keeps.
  await addRequest(req.bToC, coB, inv.c);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM paystack_payment_requests WHERE id = ANY($1::uuid[])', [Object.values(req)]);
    for (const id of companies) {
      for (const t of ['archive_customer_invoices', 'archive_runs', 'customer_invoices', 'customers']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id=$1`, [id]);
      }
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

describe('R-186: archive skips Paystack-referenced customer invoices', () => {
  it('the preview predicts the skip, counting only this company\'s requests', async () => {
    const preview = await drive(coA, () => previewArchive(coA, CUTOFF), false);
    expect(preview.customerInvoices).toBe(1);
    expect(preview.customerInvoicesSkipped).toBe(1);
    expect(preview.totalRecords).toBe(1);

    const previewC = await drive(coC, () => previewArchive(coC, CUTOFF), false);
    expect(previewC.customerInvoices).toBe(1);
    expect(previewC.customerInvoicesSkipped).toBe(0);
  }, 40000);

  it('archives the free invoice, skips the referenced one, and leaves it and its request intact', async () => {
    let result: Awaited<ReturnType<typeof executeArchive>>;
    try {
      result = await drive(coA, () => executeArchive(coA, CUTOFF, user), true);
    } catch (err) {
      throw new Error(`executeArchive threw ${(err as { code?: string }).code ?? ''} ${(err as Error).message}`);
    }
    expect(result.invoicesArchived).toBe(1);
    expect(result.invoicesSkipped).toBe(1);

    const live = (await pool.query('SELECT id FROM customer_invoices WHERE company_id=$1', [coA])).rows.map((r) => r.id);
    expect(live).toEqual([inv.aRef]);
    const archived = (await pool.query('SELECT id FROM archive_customer_invoices WHERE company_id=$1', [coA])).rows.map((r) => r.id);
    expect(archived).toEqual([inv.aFree]);
    const request = (await pool.query(
      'SELECT customer_invoice_id, status FROM paystack_payment_requests WHERE id=$1', [req.a])).rows[0];
    expect(request).toEqual({ customer_invoice_id: inv.aRef, status: 'completed' });
    expect(await count("SELECT count(*)::int AS n FROM archive_runs WHERE company_id=$1 AND status='completed'", [coA])).toBe(1);

    // Company B was not touched by A's run.
    expect(await count('SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [coB])).toBe(1);
  }, 40000);

  it('a request in another company does not shield the invoice: the delete still fails whole on 23514', async () => {
    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await drive(coC, () => executeArchive(coC, CUTOFF, user), true);
    } catch (err) {
      code = (err as { code?: string }).code;
      constraint = (err as { constraint?: string }).constraint;
    }
    expect(code, 'company B\'s request shielded company C\'s invoice').toBe('23514');
    expect(constraint).toBe('paystack_pr_invoice_has_invoice');
    expect(await count('SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [coC])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM archive_customer_invoices WHERE company_id=$1', [coC])).toBe(0);
  }, 40000);
});
