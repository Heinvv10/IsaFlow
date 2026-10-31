// Two-tenant fixture for the aging company-scope suites. Callers run their own
// DB guard (assertNotProductionDb) before seedAgingScope.
//
// Company A owns: customer CUST_A, supplier SUPP_A, and one "poisoned" invoice,
// credit note and bill, each naming company B's party (the party id on these
// tables is a bare id, or an FK to the parent's id alone, so nothing at the
// schema level stops it).
// Company B owns its own customer, supplier, invoice (5000), bill (6000) and
// credit note, none of which may ever reach company A's aging.
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export interface AgingScope {
  A: string; B: string; USER: string;
  CUST_A: string; CUST_B: string; SUPP_A: string; SUPP_B: string;
  TAG: string; LEAK_CUSTOMER: string; LEAK_SUPPLIER: string;
}

/** A's legitimate and poisoned amounts, and B's own (which must never appear in A). */
export const AMOUNTS = {
  arOk: 1000, arPoisoned: 777, arB: 5000,
  cnOk: 100, cnPoisoned: 55, cnB: 400,
  apOk: 2000, apPoisoned: 888, apB: 6000,
} as const;

export function newAgingScope(): AgingScope {
  const TAG = `SCOPE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    A: randomUUID(), B: randomUUID(), USER: randomUUID(),
    CUST_A: randomUUID(), CUST_B: randomUUID(), SUPP_A: randomUUID(), SUPP_B: randomUUID(),
    TAG, LEAK_CUSTOMER: `Tenant B Customer ${TAG}`, LEAK_SUPPLIER: `Tenant B Supplier ${TAG}`,
  };
}

export async function seedAgingScope(pool: Pool, s: AgingScope): Promise<void> {
  for (const [id, name] of [[s.A, 'Scope A'], [s.B, 'Scope B']] as const) {
    await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1,$2,true)`, [id, `${name} ${s.TAG}`]);
  }
  await pool.query(`INSERT INTO customers (id, company_id, name) VALUES ($1,$2,$3),($4,$5,$6)`,
    [s.CUST_A, s.A, `Tenant A Customer ${s.TAG}`, s.CUST_B, s.B, s.LEAK_CUSTOMER]);
  await pool.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,$3),($4,$5,$6)`,
    [s.SUPP_A, s.A, `Tenant A Supplier ${s.TAG}`, s.SUPP_B, s.B, s.LEAK_SUPPLIER]);

  await arInvoice(pool, s, s.A, 'OK', s.CUST_A, AMOUNTS.arOk);
  await arInvoice(pool, s, s.A, 'POISONED', s.CUST_B, AMOUNTS.arPoisoned);
  await arInvoice(pool, s, s.B, 'B-OWN', s.CUST_B, AMOUNTS.arB);
  await creditNote(pool, s, s.A, 'OK', s.CUST_A, AMOUNTS.cnOk);
  await creditNote(pool, s, s.A, 'POISONED', s.CUST_B, AMOUNTS.cnPoisoned);
  await creditNote(pool, s, s.B, 'B-OWN', s.CUST_B, AMOUNTS.cnB);
  await apInvoice(pool, s, s.A, 'OK', s.SUPP_A, AMOUNTS.apOk);
  await apInvoice(pool, s, s.A, 'POISONED', s.SUPP_B, AMOUNTS.apPoisoned);
  await apInvoice(pool, s, s.B, 'B-OWN', s.SUPP_B, AMOUNTS.apB);
}

export async function dropAgingScope(pool: Pool, s: AgingScope): Promise<void> {
  for (const co of [s.A, s.B]) {
    await pool.query('DELETE FROM credit_notes WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  }
}

async function arInvoice(pool: Pool, s: AgingScope, co: string, tag: string, customer: string, total: number): Promise<void> {
  await pool.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,'2026-05-01','2026-05-31','approved',$4,0,$5)`,
    [co, customer, `${s.TAG}-AR-${tag}`, total, s.USER],
  );
}

async function creditNote(pool: Pool, s: AgingScope, co: string, tag: string, customer: string, total: number): Promise<void> {
  await pool.query(
    `INSERT INTO credit_notes
       (company_id, client_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
     VALUES ($1,$2,$3,'2026-05-15','customer','approved',$4,0,$5)`,
    [co, customer, `CN-${s.TAG.slice(-9)}-${tag}`, total, s.USER],
  );
}

async function apInvoice(pool: Pool, s: AgingScope, co: string, tag: string, supplier: string, total: number): Promise<void> {
  await pool.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,'2026-05-01','2026-05-31','approved',$4,0,$5)`,
    [co, supplier, `${s.TAG}-AP-${tag}`, total, s.USER],
  );
}
