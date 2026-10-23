/**
 * R-035 PR5 fixture: a company that can PAY a supplier (payable, a bank GL
 * account and an open 2026), suppliers WITH bank details (the digest reads
 * them live), approved bills to pay, DRAFT single payments and DRAFT batches
 * planted with their allocations, enforcement planted per type, and the real
 * routes a person drives — approve / process a payment
 * (supplier-payments-action) or a batch (batch-payments-action), the detail
 * GETs, raise and decide (approval-requests).
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';
import batchPayments from '../../pages/api/accounting/batch-payments';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { callRoute, newCompany } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr4 } from './r035-pr4.helpers';

type Db = Pool | PoolClient;
type Tokens = Record<string, string>;
export type PayType = 'supplier_payment' | 'payment_batch';

/** newCompany plus what processing a payment needs; returns the company and its bank GL account. */
export async function payCompany(pool: Pool, members: [string, string][], companies: string[]) {
  const company = await newCompany(pool, members, companies);
  const tag = company.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,$2,'R035 AP','liability','credit',true,true,'payable')`, [company, `AP${tag}`]);
  const bank = (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype,
       bank_account_number,bank_branch_code)
     VALUES ($1,$2,'R035 Bank','asset','debit',true,'bank','40000000001','250655') RETURNING id`, [company, `BK${tag}`])).rows[0].id as string;
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R035 2026',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  clearSystemAccountCache(company);
  return { company, bank };
}

/**
 * Enforcement planted directly, for BOTH payment types: the switches are
 * coupled (Hein, 2026-10-06, D1 — the API always moves them together), so a
 * company never has one without the other. `type` is kept for readability.
 */
export async function enforcePay(db: Db, company: string, _type: PayType, by: string, enabledAt?: string): Promise<void> {
  for (const type of ['supplier_payment', 'payment_batch']) {
    await db.query(
      `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at)
       VALUES($1,$2,$3,COALESCE($4::TIMESTAMPTZ, now()))
       ON CONFLICT (company_id, document_type) DO NOTHING`, [company, type, by, enabledAt ?? null]);
  }
}

/** A supplier with a full set of bank details. */
export async function plantSupplier(db: Db, company: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO suppliers(id,company_id,name,bank_name,bank_account_number,bank_branch_code,bank_account_type,bank_account_holder)
     VALUES($1,$2,$3,'R035 Bank','62000000001','250655','current','R035 Holder')`, [id, company, `r035 ${id.slice(0, 6)}`]);
  return id;
}

/** An APPROVED bill of `total` owing in full, by `createdBy`. */
export async function plantBill(db: Db, company: string, supplierId: string, createdBy: string, total = 5000): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,due_date,subtotal,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,DATE '2026-08-01',DATE '2026-09-01',$5,$5,0,'approved',$6)`,
    [id, company, `BILL-${id.slice(0, 8)}`, supplierId, total, createdBy]);
  return id;
}

export interface Payment { id: string; supplierId: string; billId: string; number: string }

/** A DRAFT single payment of `amount` (default R1 150) to its own supplier, allocated to one bill of its own. */
export async function plantPayment(db: Db, company: string, createdBy: string, bank: string, opts: {
  amount?: number; supplierId?: string; billBy?: string; batchId?: string; status?: string;
} = {}): Promise<Payment> {
  const supplierId = opts.supplierId ?? await plantSupplier(db, company);
  const billId = await plantBill(db, company, supplierId, opts.billBy ?? createdBy);
  const amount = opts.amount ?? 1150;
  const { rows: [row] } = await db.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,reference,
       status,batch_id,created_by)
     VALUES($1,$2,DATE '2026-09-01',$3,'eft',$4,'R035 ref',$5,$6,$7) RETURNING id, payment_number`,
    [company, supplierId, amount, opts.batchId ? null : bank, opts.status ?? 'draft', opts.batchId ?? null, createdBy]);
  await db.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)',
    [row.id, billId, amount]);
  return { id: row.id, supplierId, billId, number: row.payment_number };
}

export interface Batch { id: string; number: string; members: Payment[] }

/** A DRAFT batch of `amounts.length` members (default two: R1 150 and R2 300), each to its own supplier. */
export async function plantBatch(db: Db, company: string, createdBy: string, bank: string,
  amounts: number[] = [1150, 2300]): Promise<Batch> {
  const total = amounts.reduce((s, a) => s + a, 0);
  const { rows: [b] } = await db.query(
    `INSERT INTO supplier_payment_batches(company_id,batch_date,payment_method,bank_account_id,payment_count,total_amount,created_by)
     VALUES($1,DATE '2026-09-01','eft',$2,$3,$4,$5) RETURNING id, batch_number`, [company, bank, amounts.length, total, createdBy]);
  const members: Payment[] = [];
  for (const amount of amounts) members.push(await plantPayment(db, company, createdBy, bank, { amount, batchId: b.id }));
  return { id: b.id, number: b.batch_number, members };
}

/**
 * An APPROVED batch, for the tests that send one to the bank (eft-generate / netcash/submit refuse a draft, whatever the
 * enforcement switch says). Only for a company that does not enforce payment_batch: the status UPDATE would otherwise
 * need the approval the DB trigger demands.
 */
export async function plantApprovedBatch(db: Db, company: string, createdBy: string, bank: string,
  amounts: number[] = [1150, 2300]): Promise<Batch> {
  const batch = await plantBatch(db, company, createdBy, bank, amounts);
  await db.query("UPDATE supplier_payment_batches SET status = 'approved' WHERE id = $1 AND company_id = $2", [batch.id, company]);
  return batch;
}

export const digestOf = async (db: Db, company: string, type: PayType, id: string) => (await db.query(
  'SELECT approval_document_digest($1,$2,$3) AS d', [company, type, id])).rows[0].d as string | null;

export const authorsOf = async (db: Db, company: string, type: PayType, id: string) => (await db.query(
  'SELECT approval_document_authors($1,$2,$3) AS a', [company, type, id])).rows[0].a as string[] | null;

/** The payment, its journal link, how many auto_supplier_payment journals the company has, and its bill's amount_paid. */
export async function paymentState(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT sp.status, sp.gl_journal_entry_id, sp.approved_by,
            (SELECT count(*)::INT FROM gl_journal_entries je
              WHERE je.company_id = sp.company_id AND je.source IN ('auto_supplier_payment', 'auto_batch_payment')) AS journals,
            (SELECT COALESCE(SUM(si.amount_paid), 0)::FLOAT8 FROM supplier_invoices si
              JOIN payment_allocations pa ON pa.invoice_id = si.id WHERE pa.payment_id = sp.id) AS paid
     FROM supplier_payments sp WHERE sp.id = $1`, [id]);
  return rows[0] as { status: string; gl_journal_entry_id: string | null; approved_by: string | null; journals: number; paid: number };
}

export async function batchState(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT b.status, b.gl_journal_entry_id,
            ARRAY(SELECT sp.status FROM supplier_payments sp WHERE sp.batch_id = b.id ORDER BY sp.total_amount)::TEXT[] AS members,
            (SELECT count(*)::INT FROM gl_journal_entries je WHERE je.company_id = b.company_id AND je.source = 'auto_batch_payment') AS journals,
            (SELECT COALESCE(SUM(si.amount_paid), 0)::FLOAT8 FROM supplier_invoices si
              JOIN payment_allocations pa ON pa.invoice_id = si.id
              JOIN supplier_payments sp ON sp.id = pa.payment_id WHERE sp.batch_id = b.id) AS paid
     FROM supplier_payment_batches b WHERE b.id = $1`, [id]);
  return rows[0] as { status: string; gl_journal_entry_id: string | null; members: string[]; journals: number; paid: number };
}

export function payRoutes(tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const requestDigest = async (pool: Pool, requestId: string) => (await pool.query(
    'SELECT document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.document_digest as string;
  const r = {
    payment: (user: string, company: string, action: string, paymentId: string) => callRoute(
      supplierPaymentsAction, as(user), company, 'POST', { action, paymentId }, '/api/accounting/supplier-payments-action'),
    batch: (user: string, company: string, action: string, id: string) => callRoute(
      batchPaymentsAction, as(user), company, 'POST', { action, id }, '/api/accounting/batch-payments-action'),
    getPayment: (user: string, company: string, id: string) => callRoute(
      supplierPayments, as(user), company, 'GET', undefined, '/api/accounting/supplier-payments', { id }),
    getBatch: (user: string, company: string, id: string) => callRoute(
      batchPayments, as(user), company, 'GET', undefined, '/api/accounting/batch-payments', { id }),
    raise: (user: string, company: string, documentType: PayType, documentId: string) => callRoute(
      approvalRequests, as(user), company, 'POST', { action: 'request', documentType, documentId },
      '/api/accounting/approval-requests'),
    decide: async (pool: Pool, user: string, company: string, requestId: string, action: 'approve' | 'reject' = 'approve') =>
      callRoute(approvalRequests, as(user), company, 'POST',
        { action, requestId, expectedDigest: await requestDigest(pool, requestId) }, '/api/accounting/approval-requests'),
    /** `requester` raises, `approver` approves; both must answer 200. Returns the request id. */
    approvedBy: async (pool: Pool, requester: string, approver: string, company: string, type: PayType, id: string) => {
      const raised = await r.raise(requester, company, type, id);
      if (raised.state.statusCode !== 200) throw new Error(`raise: ${JSON.stringify(raised.state.body)}`);
      const requestId = dataOf<{ id: string }>(raised).id;
      const decided = await r.decide(pool, approver, company, requestId);
      if (decided.state.statusCode !== 200) throw new Error(`decide: ${JSON.stringify(decided.state.body)}`);
      return requestId;
    },
  };
  return r;
}

/** `fn` on one request transaction, ALS-bound as withAuth runs it, committed unless it throws. */
export async function inRequest<T>(pool: Pool, userId: string, companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: {} } as never, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Payments, allocations and batches first (they reference bills, suppliers, journals), then PR4's teardown. */
export async function cleanupPr5(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('UPDATE supplier_payments SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE supplier_payment_batches SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM netcash_submissions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_payment_batches WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupPr4(pool, companies, users);
}
