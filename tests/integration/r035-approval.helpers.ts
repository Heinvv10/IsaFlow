/**
 * Shared fixture for the R-035 approval-enforcement integration tests: users
 * with signed tokens, one company per case, rules, and supplier invoices WITH
 * lines — the digest covers the lines, so a header-only bill proves nothing.
 */
import type { Pool, PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { request, response } from './mfa-impersonation-postgres.helpers';

type Db = Pool | PoolClient;
type Handler = (req: never, res: never) => unknown;

export const sign = (id: string) => new SignJWT({ sub: id, aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

export async function createUser(pool: Pool, tokens: Record<string, string>): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@test.local`]);
  tokens[id] = await sign(id);
  return id;
}

export async function newCompany(db: Db, members: [string, string][], companies?: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `R035 ${id.slice(0, 8)}`]);
  for (const [userId, role] of members) {
    await db.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [id, userId, role]);
  }
  companies?.push(id);
  return id;
}

export async function plantRule(db: Db, companyId: string, approverRole: string, opts: {
  documentType?: string; operator?: string; value?: number; name?: string;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES($1,$2,$3,$4,'amount',$5,$6,$7,true)`,
    [id, companyId, opts.name ?? `r035 ${approverRole}`, opts.documentType ?? 'supplier_invoice',
      opts.operator ?? 'any', opts.value ?? 0, approverRole]);
  return id;
}

export interface Bill { id: string; supplierId: string; accountA: string; accountB: string }

/**
 * A draft bill of R1 150 (1 000 + 15% VAT) with two lines on two accounts.
 * `functionalTotal`/`currencyCode` let a case plant a foreign-currency bill.
 */
export async function plantBill(db: Db, companyId: string, createdBy: string, opts: {
  total?: number; functionalTotal?: number | null; currencyCode?: string; exchangeRate?: number;
} = {}): Promise<Bill> {
  const id = crypto.randomUUID();
  const supplierId = crypto.randomUUID();
  const accountA = crypto.randomUUID();
  const accountB = crypto.randomUUID();
  await db.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplierId, companyId, `r035 ${id.slice(0, 6)}`]);
  for (const [account, code] of [[accountA, `A${id.slice(0, 6)}`], [accountB, `B${id.slice(0, 6)}`]]) {
    await db.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
       VALUES($1,$2,$3,$3,'expense','debit')`, [account, companyId, code]);
  }
  await db.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,due_date,subtotal,tax_rate,
       tax_amount,total_amount,functional_total,currency,currency_code,exchange_rate,status,created_by)
     VALUES($1,$2,$3,$4,DATE '2026-09-01',DATE '2026-10-01',1000,15,150,$5,$6,'ZAR',$7,$8,'draft',$9)`,
    [id, companyId, `R035-${id.slice(0, 8)}`, supplierId, opts.total ?? 1150,
      opts.functionalTotal === undefined ? null : opts.functionalTotal, opts.currencyCode ?? 'ZAR',
      opts.exchangeRate ?? 1, createdBy]);
  await db.query(
    `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,tax_rate,tax_amount,line_total,gl_account_id)
     VALUES($1,'Line A',2,300,15,90,600,$2),($1,'Line B',1,400,15,60,400,$3)`, [id, accountA, accountB]);
  return { id, supplierId, accountA, accountB };
}

export async function callRoute(handler: Handler, token: string, companyId: string, method: string,
  body: unknown, url: string, query: Record<string, string> = {}) {
  const req = request({ 'sb-access-token': token, active_company_id: companyId }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = query;
  req.url = url;
  const result = response();
  await handler(req as never, result.res as never);
  return result;
}

export const reasonOf = (result: { state: { body: unknown } }) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

export async function cleanup(pool: Pool, companies: string[], users: string[]): Promise<void> {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_enforcement WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM suppliers WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM customers WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
}
