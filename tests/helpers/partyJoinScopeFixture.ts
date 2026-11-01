// Company A's documents for the party-join scope suites, on top of the aging
// two-tenant fixture (agingScopeFixture): each kind of row exists twice in A, an
// OK one naming A's party and a POISONED one naming B's. A list must carry the
// POISONED row without B's name, and the OK row under A's name.
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { AgingScope } from './agingScopeFixture';

export type Variant = 'OK' | 'POISONED';

interface Ids {
  apInvoice: string; arInvoice: string; poolPo: string; supplierPo: string; supplierPayment: string;
  customerPayment: string; deliveryNote: string; salesOrder: string; timeEntry: string; recon: string;
}
export type PartyDocs = Record<Variant, Ids> & { bankAccount: string; template: string };

/** The document number every OK / POISONED row of `kind` carries. */
export const docNo = (s: AgingScope, kind: string, v: Variant): string => `${s.TAG.slice(-9)}-${kind}-${v}`;

const one = async (pool: Pool, text: string, values: unknown[]): Promise<string> =>
  String((await pool.query(text, values)).rows[0].id);

async function seedSupplierSide(pool: Pool, s: AgingScope, v: Variant, sup: string): Promise<Partial<Ids>> {
  const { A, USER } = s;
  const n = (kind: string) => docNo(s, kind, v);
  const { rows: [bill] } = await pool.query(
    'SELECT id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [A, `${s.TAG}-AP-${v}`]);
  const supplierPo = await one(pool, `INSERT INTO supplier_purchase_orders (company_id, order_number, supplier_id)
    VALUES ($1,$2,$3) RETURNING id`, [A, n('SPO'), sup]);
  const poolPo = await one(pool, `INSERT INTO purchase_orders (company_id, po_number, supplier_id, status, total)
    VALUES ($1,$2,$3,'approved',4321) RETURNING id`, [A, n('PO'), sup]);
  const supplierPayment = await one(pool, `INSERT INTO supplier_payments
    (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
    VALUES ($1,$2,$3,'2026-05-02',10,'processed',$4) RETURNING id`, [A, n('SP'), sup, USER]);
  await pool.query('INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1,$2,10)',
    [supplierPayment, bill.id]);
  await pool.query(`INSERT INTO credit_notes
    (company_id, supplier_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
    VALUES ($1,$2,$3,'2026-05-15','supplier','approved',20,0,$4)`, [A, sup, n('SCN'), USER]);
  await pool.query(`INSERT INTO fraud_alerts (company_id, supplier_id, signal_type) VALUES ($1,$2,$3)`, [A, sup, n('FA')]);
  const doc = await one(pool, `INSERT INTO captured_documents (company_id, file_name, file_type)
    VALUES ($1,$2,'application/pdf') RETURNING id`, [A, n('DOC')]);
  const recon = await one(pool, `INSERT INTO supplier_statement_reconciliations
    (company_id, supplier_id, source_document_id, statement_date, supplier_balance, isaflow_balance, variance)
    VALUES ($1,$2,$3,'2026-05-31',1,1,0) RETURNING id`, [A, sup, doc]);
  await pool.query(`INSERT INTO accounting_adjustments
    (company_id, adjustment_number, entity_type, entity_id, adjustment_type, amount, reason, created_by)
    VALUES ($1,$2,'supplier',$3,'debit',5,'scope',$4)`, [A, n('ADJS'), sup, USER]);
  return { apInvoice: String(bill.id), supplierPo, poolPo, supplierPayment, recon };
}

async function seedCustomerSide(pool: Pool, s: AgingScope, v: Variant, cust: string, template: string, bank: string): Promise<Partial<Ids>> {
  const { A, USER } = s;
  const n = (kind: string) => docNo(s, kind, v);
  const { rows: [inv] } = await pool.query(
    'SELECT id FROM customer_invoices WHERE company_id = $1 AND invoice_number = $2', [A, `${s.TAG}-AR-${v}`]);
  const customerPayment = await one(pool, `INSERT INTO customer_payments
    (company_id, payment_number, client_id, payment_date, total_amount, status, created_by)
    VALUES ($1,$2,$3,'2026-05-02',10,'confirmed',$4) RETURNING id`, [A, n('CP'), cust, USER]);
  await pool.query('INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1,$2,10)',
    [customerPayment, inv.id]);
  const deliveryNote = await one(pool, `INSERT INTO delivery_notes (company_id, customer_id, delivery_note_number)
    VALUES ($1,$2,$3) RETURNING id`, [A, cust, n('DN')]);
  const salesOrder = await one(pool, `INSERT INTO customer_sales_orders (company_id, order_number, customer_id, status)
    VALUES ($1,$2,$3,'draft') RETURNING id`, [A, n('SO'), cust]);
  await pool.query(`INSERT INTO customer_write_offs
    (company_id, write_off_number, client_id, invoice_id, amount, reason, created_by)
    VALUES ($1,$2,$3,$4,5,'scope',$5)`, [A, n('WO'), cust, inv.id, USER]);
  await pool.query(`INSERT INTO recurring_invoices
    (company_id, template_name, client_id, frequency, next_run_date, created_by)
    VALUES ($1,$2,$3,'monthly','2026-06-01',$4)`, [A, n('RI'), cust, USER]);
  const timeEntry = await one(pool, `INSERT INTO time_entries
    (company_id, user_id, task_description, hours, customer_id, status, billable, invoiced, rate, entry_date)
    VALUES ($1,$2,$3,2,$4,'approved',true,false,100,'2026-05-03') RETURNING id`, [A, USER, n('TE'), cust]);
  await pool.query(`INSERT INTO accounting_adjustments
    (company_id, adjustment_number, entity_type, entity_id, adjustment_type, amount, reason, created_by)
    VALUES ($1,$2,'customer',$3,'credit',5,'scope',$4)`, [A, n('ADJC'), cust, USER]);
  await pool.query(`INSERT INTO projects (company_id, project_number, name, client_id, status)
    VALUES ($1,$2,$3,$4,'active')`, [A, n('PRJ'), n('PRJ'), cust]);
  await pool.query('INSERT INTO customer_dunning_overrides (company_id, customer_id, note) VALUES ($1,$2,$3)', [A, cust, n('DO')]);
  await pool.query(`INSERT INTO dunning_sends
    (company_id, customer_invoice_id, template_id, sent_to_email, rendered_subject, rendered_body)
    VALUES ($1,$2,$3,'x@test.local',$4,'body')`, [A, inv.id, template, n('DS')]);
  await pool.query(`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_pattern, client_id)
    VALUES ($1,$2,'scope',$3)`, [A, n('BR'), cust]);
  await pool.query(`INSERT INTO bank_transactions
    (company_id, bank_account_id, transaction_date, amount, description, suggested_client_id, suggested_supplier_id,
     status, feed_state, bank_reference)
    VALUES ($1,$2,'2026-05-04',11,$3,$4,$5,'imported','posted',$6)`,
    [A, bank, n('BT'), cust, v === 'OK' ? s.SUPP_A : s.SUPP_B, n('BT')]);
  return { arInvoice: String(inv.id), customerPayment, deliveryNote, salesOrder, timeEntry };
}

export async function seedPartyDocs(pool: Pool, s: AgingScope): Promise<PartyDocs> {
  const bankAccount = await one(pool, `INSERT INTO gl_accounts
    (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
    VALUES ($1,$2,$3,'Scope bank','asset','bank','debit') RETURNING id`, [randomUUID(), s.A, s.TAG.slice(-9)]);
  const template = await one(pool, `INSERT INTO dunning_templates (company_id, name, days_overdue_min, subject_template, body_template)
    VALUES ($1,$2,1,'s','b') RETURNING id`, [s.A, `T ${s.TAG}`]);
  const ok = { ...await seedSupplierSide(pool, s, 'OK', s.SUPP_A), ...await seedCustomerSide(pool, s, 'OK', s.CUST_A, template, bankAccount) };
  const bad = { ...await seedSupplierSide(pool, s, 'POISONED', s.SUPP_B), ...await seedCustomerSide(pool, s, 'POISONED', s.CUST_B, template, bankAccount) };
  return { OK: ok as Ids, POISONED: bad as Ids, bankAccount, template };
}

/** Everything seedPartyDocs wrote; call before dropAgingScope. */
export async function dropPartyDocs(pool: Pool, s: AgingScope): Promise<void> {
  const co = [s.A];
  await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [co]);
  await pool.query('DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ANY($1))', [co]);
  for (const table of ['supplier_payments', 'customer_payments', 'supplier_purchase_orders', 'purchase_orders', 'fraud_alerts',
    'supplier_statement_reconciliations', 'captured_documents', 'accounting_adjustments', 'delivery_notes', 'customer_sales_orders',
    'customer_write_offs', 'recurring_invoices', 'time_entries', 'projects', 'customer_dunning_overrides', 'dunning_sends',
    'dunning_templates', 'bank_categorisation_rules', 'bank_transactions', 'gl_accounts']) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = ANY($1)`, [co]);
  }
}
