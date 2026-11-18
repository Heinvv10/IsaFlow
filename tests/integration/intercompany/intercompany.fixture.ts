/**
 * Fixture for the intercompany (1000 + 1002) suites: real PostgreSQL, synthetic rows only.
 *
 *   A, B   current members of group G           C   in another group (H), never with A or B
 *   ab owner of A and B     a owner of A     b owner of B     c owner of C     ac owner of A and C
 *   va viewer of A          avb owner of A, viewer of B       mab manager of A and B       x a member of nothing    vc viewer of C
 */
import type { Pool } from 'pg';
import { createUser } from '../r035-approval.helpers';

export const U = { ab: '', a: '', b: '', c: '', ac: '', va: '', avb: '', mab: '', x: '', vc: '' };
export const tokens: Record<string, string> = {};
export const co = { A: '', B: '', C: '', G: '', H: '' };
export const acct = { aLoan: '', aExpense: '', aHeader: '', aChild: '', aInactive: '', bLoan: '' };
export const party = { aCustomer: '', aSupplier: '', bCustomer: '', bSupplier: '' };
export const dim = { aCc1: '', bCc1: '', aCc2: '', bCc2: '', aBu: '', bBu: '' };

export const companies: string[] = [];
export const invoices = { cust: [] as string[], supp: [] as string[], credit: [] as string[] };

export async function setup(pool: Pool): Promise<void> {
  for (const k of Object.keys(U) as (keyof typeof U)[]) U[k] = await createUser(pool, tokens);
  const mk = async (name: string, members: [string, string][]) => {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [id, `IC ${name} ${id.slice(0, 6)}`]);
    for (const [user, role] of members) {
      await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, $3)', [id, user, role]);
    }
    companies.push(id);
    return id;
  };
  co.A = await mk('A', [[U.ab, 'owner'], [U.a, 'owner'], [U.ac, 'owner'], [U.va, 'viewer'], [U.avb, 'owner'], [U.mab, 'manager']]);
  co.B = await mk('B', [[U.ab, 'owner'], [U.b, 'owner'], [U.avb, 'viewer'], [U.mab, 'manager']]);
  co.C = await mk('C', [[U.c, 'owner'], [U.ac, 'owner'], [U.vc, 'viewer']]);
  co.G = crypto.randomUUID();
  co.H = crypto.randomUUID();
  await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G'), ($2, 'IC group H')", [co.G, co.H]);
  await pool.query(
    'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3), ($4, $5)',
    [co.G, co.A, co.B, co.H, co.C]);

  for (const k of Object.keys(acct) as (keyof typeof acct)[]) acct[k] = crypto.randomUUID();
  const account = (id: string, company: string, code: string, parent: string | null, active = true) => pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, parent_account_id, is_active)
     VALUES ($1, $2, $3, $3, 'liability', 'credit', $4, $5)`, [id, company, code, parent, active]);
  const tag = co.A.slice(0, 5);
  await account(acct.aHeader, co.A, `ICH${tag}`, null);
  await account(acct.aChild, co.A, `ICC${tag}`, acct.aHeader);
  await account(acct.aLoan, co.A, `ICL${tag}`, null);
  await account(acct.aExpense, co.A, `ICE${tag}`, null);
  await account(acct.aInactive, co.A, `ICI${tag}`, null, false);
  await account(acct.bLoan, co.B, `ICL${co.B.slice(0, 5)}`, null);
  for (const k of Object.keys(party) as (keyof typeof party)[]) party[k] = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [party.aCustomer, co.A, 'IC A customer', party.bCustomer, co.B, 'IC B customer']);
  await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [party.aSupplier, co.A, 'IC A supplier', party.bSupplier, co.B, 'IC B supplier']);
  for (const k of Object.keys(dim) as (keyof typeof dim)[]) dim[k] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO cost_centres(id, company_id, code, name, cc_type) VALUES
       ($1, $5, 'IC-C1', 'A cc1', 'cc1'), ($2, $6, 'IC-C1', 'B cc1', 'cc1'), ($3, $5, 'IC-C2', 'A cc2', 'cc2'), ($4, $6, 'IC-C2', 'B cc2', 'cc2')`,
    [dim.aCc1, dim.bCc1, dim.aCc2, dim.bCc2, co.A, co.B]);
  await pool.query(`INSERT INTO business_units(id, company_id, code, name) VALUES ($1, $3, 'IC-BU', 'A bu'), ($2, $4, 'IC-BU', 'B bu')`,
    [dim.aBu, dim.bBu, co.A, co.B]);
}

export async function cleanup(pool: Pool): Promise<void> {
  const users = Object.values(U);
  const del = async (text: string, params: unknown[]) => {
    try { await pool.query(text, params); } catch (err) { process.stderr.write(`cleanup: ${text}: ${String(err)}\n`); }
  };
  await wipeConnections(pool).catch((err: unknown) => process.stderr.write(`cleanup wipe: ${String(err)}\n`));
  await del('DELETE FROM customer_invoices WHERE id = ANY($1)', [invoices.cust]);
  await del('DELETE FROM supplier_invoices WHERE id = ANY($1)', [invoices.supp]);
  await del('DELETE FROM credit_notes WHERE id = ANY($1)', [invoices.credit]);
  await del('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await del('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM company_group_members WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await del('DELETE FROM company_groups WHERE id = ANY($1)', [[co.G, co.H]]);
  await del('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await del('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await pool.end();
}

/** Every row of the five tables for these companies, so a test starts clean (links first: they name messages). */
export async function wipeConnections(pool: Pool): Promise<void> {
  const where: Record<string, string> = {
    intercompany_document_links: 'company_a_id = ANY($1) OR company_b_id = ANY($1)',
    intercompany_messages: 'from_company_id = ANY($1) OR to_company_id = ANY($1)',
    intercompany_connection_sides: 'company_id = ANY($1)',
    intercompany_connections: 'company_low_id = ANY($1) OR company_high_id = ANY($1)',
    company_connection_keys: 'company_id = ANY($1)',
  };
  for (const [table, predicate] of Object.entries(where)) await pool.query(`DELETE FROM ${table} WHERE ${predicate}`, [companies]);
  // A test that moved a company out of its group puts it back.
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, c FROM unnest($2::uuid[]) c ON CONFLICT DO NOTHING', [co.G, [co.A, co.B]]);
}


/** An invoice document of `company`, as the manual-pairing check finds it. */
export async function plantDocument(pool: Pool, type: 'customer_invoice' | 'supplier_invoice' | 'credit_note', company: string, by = U.ab): Promise<string> {
  const id = crypto.randomUUID();
  if (type === 'customer_invoice') {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [customer, company, `IC doc ${id.slice(0, 6)}`]);
    await pool.query(
      `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
         total_amount, currency_code, exchange_rate, status, created_by)
       VALUES ($1, $2, $3, $4, $4, DATE '2026-09-01', DATE '2026-10-01', 1000, 15, 150, 1150, 'ZAR', 1, 'draft', $5)`,
      [id, company, `ICI-${id.slice(0, 8)}`, customer, by]);
    invoices.cust.push(id);
  } else if (type === 'supplier_invoice') {
    const supplier = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [supplier, company, `IC doc ${id.slice(0, 6)}`]);
    await pool.query(
      `INSERT INTO supplier_invoices(id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
         total_amount, currency, currency_code, exchange_rate, status, created_by)
       VALUES ($1, $2, $3, $4, DATE '2026-09-01', DATE '2026-10-01', 1000, 15, 150, 1150, 'ZAR', 'ZAR', 1, 'draft', $5)`,
      [id, company, `ICS-${id.slice(0, 8)}`, supplier, by]);
    invoices.supp.push(id);
  } else {
    await pool.query(
      `INSERT INTO credit_notes(id, company_id, credit_note_number, type, credit_date, total_amount, created_by)
       VALUES ($1, $2, $3, 'customer', DATE '2026-09-05', 100, $4)`, [id, company, `ICN-${id.slice(0, 8)}`, by]);
    invoices.credit.push(id);
  }
  return id;
}

