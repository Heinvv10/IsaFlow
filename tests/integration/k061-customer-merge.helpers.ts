/**
 * K-061 shared set-up: two companies, one admin, and a "footprint" — one row
 * in every table the customer-merge census (docs/audits/remediation/K-061/
 * fix.md) says a merge must move — for any customer. The merge is driven
 * through the real exported route: withAuth (app_user, RLS), withCsrf,
 * withWriteAccess. Nothing is mocked.
 */
import type { Pool } from 'pg';
import { SignJWT } from 'jose';
import customerMerge from '../../pages/api/accounting/customer-merge';
import duplicatesMerge from '../../pages/api/accounting/duplicates-merge';
import { request, response } from './mfa-impersonation-postgres.helpers';

/** [table, column, extra predicate] for every reference a merge must move. */
export const MOVED: ReadonlyArray<readonly [string, string, string]> = [
  ['customer_invoices', 'customer_id', ''],
  ['customer_invoices', 'client_id', ''],
  ['customer_payments', 'client_id', ''],
  ['credit_notes', 'client_id', ''],
  ['customer_quotes', 'client_id', ''],
  ['customer_sales_orders', 'customer_id', ''],
  ['delivery_notes', 'customer_id', ''],
  ['customer_write_offs', 'client_id', ''],
  ['projects', 'client_id', ''],
  ['customer_contacts', 'customer_id', ''],
  ['customer_delivery_addresses', 'customer_id', ''],
  ['customer_activities', 'customer_id', ''],
  ['recurring_invoices', 'client_id', ''],
  ['recurring_transaction_templates', "template_data->>'clientId'", "AND entity_type = 'customer_invoice'"],
  ['customer_dunning_overrides', 'customer_id', ''],
  ['bank_categorisation_rules', 'client_id', ''],
  ['bank_transactions', 'suggested_client_id', ''],
  ['payment_transactions', 'customer_id', ''],
  ['time_entries', 'customer_id', ''],
  ['practice_clients', 'link_customer_id', ''],
  ['accounting_adjustments', 'entity_id', "AND entity_type = 'customer'"],
  ['entity_udf_values', 'entity_id', "AND entity_type = 'customer'"],
  ['portal_payment_links', 'client_id', ''],
];

export function k061(pool: Pool) {
  const companyA = crypto.randomUUID();
  const companyB = crypto.randomUUID();
  const admin = crypto.randomUUID();
  let token = '';
  const bank: Record<string, string> = {};

  async function setUp() {
    for (const [id, name] of [[companyA, 'K061 A'], [companyB, 'K061 B']] as const) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
      bank[id] = (await pool.query<{ id: string }>(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
         VALUES ($1,'K061-BANK','K061 bank','asset','debit',1) RETURNING id`, [id])).rows[0]!.id;
    }
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
    for (const c of [companyA, companyB]) {
      await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [c, admin]);
    }
    token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }

  async function wipe() {
    const ids = [companyA, companyB];
    await pool.query('DELETE FROM portal_payment_links WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM portal_access WHERE client_id IN (SELECT id FROM customers WHERE company_id = ANY($1))', [ids]);
    for (const t of ['customer_write_offs', 'credit_notes', 'customer_payments', 'customer_invoices',
      'customer_quotes', 'delivery_notes', 'customer_sales_orders', 'projects',
      'customer_contacts', 'customer_delivery_addresses', 'customer_activities', 'recurring_invoices',
      'customer_dunning_overrides', 'recurring_transaction_templates', 'bank_categorisation_rules', 'bank_transactions', 'payment_transactions',
      'time_entries', 'practice_clients', 'accounting_adjustments', 'entity_udf_values', 'customers']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [ids]);
    }
  }

  async function tearDown() {
    try {
      await wipe();
      await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [[companyA, companyB]]);
      await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[companyA, companyB]]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[companyA, companyB]]);
      await pool.query('DELETE FROM users WHERE id=$1', [admin]);
    } finally { await pool.end(); }
  }

  async function customer(company: string, name: string): Promise<string> {
    return (await pool.query<{ id: string }>(
      'INSERT INTO customers(company_id,name) VALUES($1,$2) RETURNING id', [company, name])).rows[0]!.id;
  }

  /** One row per MOVED reference for `cust`, plus a portal login. `n` keeps numbers unique. */
  async function footprint(company: string, cust: string, n: string) {
    const q = (text: string, values: unknown[]) => pool.query(text, values);
    const inv = (await pool.query<{ id: string }>(
      `INSERT INTO customer_invoices(company_id,invoice_number,customer_id,client_id,invoice_date,subtotal,total_amount,status,created_by)
       VALUES($1,$2,$3,NULL,'2026-06-01',100,100,'approved',$4) RETURNING id`, [company, `K061-${n}-1`, cust, admin])).rows[0]!.id;
    await q(`INSERT INTO customer_invoices(company_id,invoice_number,customer_id,client_id,invoice_date,subtotal,total_amount,status,created_by)
       VALUES($1,$2,$3,$3,'2026-06-02',200,200,'approved',$4)`, [company, `K061-${n}-2`, cust, admin]);
    await q(`INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by,bank_account_id)
       VALUES($1,$2,'2026-06-03',40,'eft','confirmed',$3,$4)`, [company, cust, admin, bank[company]]);
    await q(`INSERT INTO credit_notes(company_id,client_id,type,credit_date,total_amount,status,created_by)
       VALUES($1,$2,'customer','2026-06-04',10,'draft',$3)`, [company, cust, admin]);
    await q("INSERT INTO customer_quotes(company_id,client_id,quote_number,status) VALUES($1,$2,$3,'draft')", [company, cust, `Q-${n}`]);
    await q("INSERT INTO customer_sales_orders(company_id,customer_id,order_number) VALUES($1,$2,$3)", [company, cust, `SO-${n}`]);
    await q("INSERT INTO delivery_notes(company_id,customer_id,delivery_note_number) VALUES($1,$2,$3)", [company, cust, `DN-${n}`]);
    await q(`INSERT INTO customer_write_offs(company_id,client_id,write_off_number,invoice_id,amount,reason,status,created_by)
       VALUES($1,$2,$3,$4,5,'k061','draft',$5)`, [company, cust, `WO-${n}`, inv, admin]);
    await q("INSERT INTO projects(company_id,client_id,project_number,name) VALUES($1,$2,$3,'k061')", [company, cust, `P-${n}`]);
    await q("INSERT INTO customer_contacts(company_id,customer_id,full_name,is_primary) VALUES($1,$2,$3,true)", [company, cust, `Contact ${n}`]);
    await q("INSERT INTO customer_delivery_addresses(company_id,customer_id,label,is_default) VALUES($1,$2,$3,true)", [company, cust, `Addr ${n}`]);
    await q("INSERT INTO customer_activities(company_id,customer_id,activity_type,description,created_by) VALUES($1,$2,'note','k061',$3)", [company, cust, admin]);
    await q(`INSERT INTO recurring_invoices(company_id,client_id,template_name,frequency,next_run_date,status,created_by)
       VALUES($1,$2,$3,'monthly','2026-10-01','active',$4)`, [company, cust, `R-${n}`, admin]);
    await q(`INSERT INTO recurring_transaction_templates(company_id,name,entity_type,template_data,frequency,next_run_date,is_active,created_by)
       VALUES($1,$2,'customer_invoice',jsonb_build_object('clientId',$3::text,'lines','[]'::jsonb),'monthly','2026-10-01',true,$4)`, [company, `T-${n}`, cust, admin]);
    await q("INSERT INTO customer_dunning_overrides(company_id,customer_id,suppress_dunning) VALUES($1,$2,false)", [company, cust]);
    await q("INSERT INTO bank_categorisation_rules(company_id,client_id,rule_name,match_pattern) VALUES($1,$2,$3,'k061')", [company, cust, `Rule ${n}`]);
    await q(`INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,suggested_client_id)
       VALUES($1,$2,'2026-06-05',40,$3)`, [company, bank[company], cust]);
    await q("INSERT INTO payment_transactions(company_id,customer_id,amount) VALUES($1,$2,40)", [company, cust]);
    await q("INSERT INTO time_entries(company_id,user_id,customer_id,task_description,hours) VALUES($1,$2,$3,'k061',1)", [company, admin, cust]);
    await q("INSERT INTO practice_clients(company_id,legal_name,link_customer_id) VALUES($1,$2,$3)", [company, `PC ${n}`, cust]);
    await q(`INSERT INTO accounting_adjustments(company_id,adjustment_number,entity_type,entity_id,adjustment_type,amount,reason,created_by)
       VALUES($1,$2,'customer',$3,'debit',1,'k061',$4)`, [company, `ADJ-${n}`, cust, admin]);
    await q("INSERT INTO entity_udf_values(company_id,entity_type,entity_id,field_number,value) VALUES($1,'customer',$2,1,$3)", [company, cust, `udf ${n}`]);
    await q("INSERT INTO portal_payment_links(invoice_id,client_id,amount) VALUES($1,$2,100)", [inv, cust]);
    await q("INSERT INTO portal_access(client_id,email,password_hash,name,is_active) VALUES($1,$2,'x','k061',true)", [cust, `${n}-${cust}@portal.test`]);
    return { inv };
  }

  /** How many rows each MOVED reference holds for `cust`, keyed "table.column". */
  async function references(cust: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [table, column, extra] of MOVED) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE (${column})::text = $1::text ${extra}`, [cust]);
      out[`${table}.${column}`] = rows[0].n;
    }
    return out;
  }

  /** A digest of every row the two companies own in every census table, for "nothing changed". */
  async function snapshot(): Promise<string> {
    const tables = [...new Set(MOVED.map(([t]) => t)), 'customers'];
    const parts: string[] = [];
    for (const t of tables) {
      const where = t === 'portal_payment_links'
        ? 'invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))'
        : 'company_id = ANY($1)';
      const { rows } = await pool.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE ${where}`, [[companyA, companyB]]);
      parts.push(`${t}:${rows[0].h}`);
    }
    const { rows } = await pool.query(
      `SELECT md5(coalesce(string_agg(p::text, '|' ORDER BY p::text), '')) AS h FROM portal_access p
       WHERE client_id IN (SELECT id FROM customers WHERE company_id = ANY($1))`, [[companyA, companyB]]);
    parts.push(`portal_access:${rows[0].h}`);
    return parts.join('\n');
  }

  function call(route: typeof customerMerge, url: string, body: Record<string, unknown>, company: string) {
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as {
      url: string; body: unknown; query: Record<string, string>;
    };
    req.url = url;
    req.query = {};
    req.body = body;
    const result = response();
    return route(req as never, result.res).then(() => result);
  }
  const merge = (body: Record<string, unknown>, company = companyA) =>
    call(customerMerge, '/api/accounting/customer-merge', body, company);
  /** The /accounting/duplicates page's route: primaryId survives, duplicateId goes. */
  const mergeDuplicate = (body: Record<string, unknown>, company = companyA) =>
    call(duplicatesMerge as typeof customerMerge, '/api/accounting/duplicates-merge', body, company);

  /** Any other real route, same session. */
  const post = (route: typeof customerMerge, url: string, body: Record<string, unknown>, company = companyA) =>
    call(route, url, body, company);

  return { companyA, companyB, admin, setUp, wipe, tearDown, customer, footprint, references, snapshot, merge, mergeDuplicate, post };
}
