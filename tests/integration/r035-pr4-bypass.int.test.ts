/**
 * R-035 PR4: the ways into the AR population that are NOT approveCustomerInvoice.
 *
 *  - confirmCustomerPayment and approveWriteOff move an invoice's status
 *    straight to paid / partially_paid with no status guard, so on a DRAFT
 *    invoice they skip approval. Under enforcement the backstop refuses them
 *    (a raised error the caller rolls back: a 500 through a route), and with
 *    enforcement off they behave as they always did. Neither service is
 *    otherwise changed.
 *  - The request INSERT guard (862) now binds customer_invoice requests: an
 *    app_user session can neither plant an already-approved request nor one
 *    raised in someone else's name; a pending request of its own still goes in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { confirmCustomerPayment } from '../../src/modules/accounting/services/ar/customerPaymentAllocationService';
import { approveWriteOff } from '../../src/modules/accounting/services/ar/writeOffService';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import {
  asAppUser, cleanupPr4, enforceInvoices, invoiceCompany, invoiceState, plantInvoice,
} from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

/** An invoice company with the bank and bad-debt accounts the two services post to. */
async function company(opts: { enforced?: boolean } = {}): Promise<string> {
  const c = await invoiceCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  const tag = c.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,$2,'R035 bank','asset','debit',true,true,'bank'), ($1,$3,'R035 bad debt','expense','debit',true,true,'admin_expense')`,
    [c, `BK${tag}`, `BD${tag}`]);
  clearSystemAccountCache(c);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice' });
  if (opts.enforced !== false) await enforceInvoices(pool, c, u.b);
  return c;
}

/** Runs `fn` in one transaction bound to ALS, as a request would; rolled back when it throws. */
async function inTx<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: u.a, companyId: c, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function draftPayment(c: string, invoiceId: string, customerId: string, amount: number): Promise<string> {
  const { rows: [p] } = await pool.query(
    `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,status,created_by,payment_number)
     VALUES($1,$2,DATE '2026-09-02',$3,'draft',$4,$5) RETURNING id`, [c, customerId, amount, u.a, `PAY-${crypto.randomUUID().slice(0, 8)}`]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)',
    [p.id, invoiceId, amount]);
  return p.id as string;
}

async function draftWriteOff(c: string, invoiceId: string, customerId: string, amount: number): Promise<string> {
  const { rows: [w] } = await pool.query(
    `INSERT INTO customer_write_offs(company_id,write_off_number,client_id,invoice_id,amount,reason,write_off_date,created_by)
     VALUES($1,$2,$3,$4,$5,'r035',DATE '2026-09-02',$6) RETURNING id`,
    [c, `WO-${crypto.randomUUID().slice(0, 8)}`, customerId, invoiceId, amount, u.a]);
  return w.id as string;
}

const journalsOf = async (c: string) => Number((await pool.query(
  'SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n);

describe('services that move a DRAFT invoice into the population without approving it', () => {
  it('confirmCustomerPayment on a gated draft is refused by the backstop: nothing posts, the invoice stays a draft', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a);
    const payment = await draftPayment(c, inv.id, inv.customerId, 1150);
    await expect(inTx(c, () => confirmCustomerPayment(c, payment, u.a))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect((await invoiceState(pool, inv.id)).status).toBe('draft');
    expect(await journalsOf(c)).toBe(0);
    expect((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [payment])).rows[0].status).toBe('draft');
  });

  it('a partial payment on a gated draft is refused too (draft → partially_paid)', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a);
    const payment = await draftPayment(c, inv.id, inv.customerId, 100);
    await expect(inTx(c, () => confirmCustomerPayment(c, payment, u.a))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect((await invoiceState(pool, inv.id)).status).toBe('draft');
  });

  it('approveWriteOff of a whole gated draft is refused: nothing posts, the invoice stays a draft', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a);
    const writeOff = await draftWriteOff(c, inv.id, inv.customerId, 1150);
    await expect(inTx(c, () => approveWriteOff(c, writeOff, u.b))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect((await invoiceState(pool, inv.id)).status).toBe('draft');
    expect(await journalsOf(c)).toBe(0);
    expect((await pool.query('SELECT status FROM customer_write_offs WHERE id = $1', [writeOff])).rows[0].status).toBe('draft');
  });

  it('enforcement off: both behave as they always did', async () => {
    const c = await company({ enforced: false });
    const paid = await plantInvoice(pool, c, u.a);
    const payment = await draftPayment(c, paid.id, paid.customerId, 1150);
    await inTx(c, () => confirmCustomerPayment(c, payment, u.a));
    expect((await invoiceState(pool, paid.id)).status).toBe('paid');
    const writtenOff = await plantInvoice(pool, c, u.a);
    const writeOff = await draftWriteOff(c, writtenOff.id, writtenOff.customerId, 1150);
    await inTx(c, () => approveWriteOff(c, writeOff, u.b));
    expect((await invoiceState(pool, writtenOff.id)).status).toBe('paid');
  });
});

describe('a customer-invoice request is inserted only as requestApproval writes it', () => {
  const insert = (cl: PoolClient, c: string, id: string, requestedBy: string, status: string) => cl.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, requested_by, status, decided_by, decided_at,
       required_role, document_digest)
     VALUES($1,'customer_invoice',$2,$3::UUID,$4::TEXT, CASE WHEN $4::TEXT = 'pending' THEN NULL ELSE $3::UUID END,
       CASE WHEN $4::TEXT = 'pending' THEN NULL ELSE now() END, 'owner', approval_document_digest($1,'customer_invoice',$2))`,
    [c, id, requestedBy, status]);

  it('app_user INSERTing an approved row is refused, and the invoice stays unpostable', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a);
    // R-035 N1 (migration 872): app_user holds no INSERT on approval_requests.
    await expect(asAppUser(pool, u.a, c, (cl) => insert(cl, c, inv.id, u.a, 'approved'))).rejects.toThrow(/permission denied for table approval_requests/);
    await expect(asAppUser(pool, u.a, c, (cl) => cl.query(
      "UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [inv.id]))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('refuses a pending row naming another requester; accepts one raised by the session user (through approval_request_raise)', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, u.a);
    await expect(asAppUser(pool, u.b, c, (cl) => insert(cl, c, inv.id, u.a, 'pending'))).rejects.toThrow(/permission denied for table approval_requests/);
    const rule = (await pool.query(
      "SELECT id FROM approval_rules WHERE company_id = $1 AND document_type = 'customer_invoice'", [c])).rows[0].id as string;
    await asAppUser(pool, u.a, c, (cl) => cl.query('SELECT * FROM approval_request_raise($1, $2, $3, $4, $5)',
      [c, 'customer_invoice', inv.id, rule, u.a]));
    const { rows } = await pool.query('SELECT status FROM approval_requests WHERE document_id = $1', [inv.id]);
    expect(rows.map((r) => r.status)).toEqual(['pending']);
  });
});
