/**
 * Plant a real document for the approval tests.
 *
 * `requestApproval` resolves the governing rule from the STORED document, so a
 * random UUID no longer names anything and every request path here needs a row
 * that actually exists. One helper, five document types, amounts the caller
 * chooses so the rule the test expects is the one the amount selects.
 */
import type { Pool } from 'pg';

export type PlantableType =
  | 'customer_invoice' | 'supplier_invoice' | 'credit_note' | 'payment' | 'journal_entry';

/** Party rows the document tables reference; created once per company. */
async function partyFor(pool: Pool, companyId: string, kind: 'customer' | 'supplier'): Promise<string> {
  const table = kind === 'customer' ? 'customers' : 'suppliers';
  const { rows } = await pool.query(`SELECT id FROM ${table} WHERE company_id=$1 LIMIT 1`, [companyId]);
  if (rows[0]) return rows[0].id as string;
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO ${table}(id,company_id,name) VALUES($1,$2,$3)`,
    [id, companyId, `approval-fixture ${kind}`]);
  return id;
}

/** A GL account for the journal lines to hit; created once per company. */
async function glAccountFor(pool: Pool, companyId: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM gl_accounts WHERE company_id=$1 LIMIT 1', [companyId]);
  if (rows[0]) return rows[0].id as string;
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$2,'9999','approval-fixture account','expense','debit')`, [id, companyId]);
  return id;
}

/** Returns the new document's id. `amount` is what the rules will be matched on. */
export async function plantDocument(
  pool: Pool,
  companyId: string,
  documentType: PlantableType,
  amount: number,
  createdBy: string
): Promise<string> {
  const id = crypto.randomUUID();
  const number = `AP-${id.slice(0, 8)}`;
  switch (documentType) {
    case 'customer_invoice': {
      const customer = await partyFor(pool, companyId, 'customer');
      await pool.query(
        `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,total_amount,created_by)
         VALUES($1,$2,$3,$4,$5,$6)`, [id, companyId, number, customer, amount, createdBy]);
      return id;
    }
    case 'supplier_invoice': {
      const supplier = await partyFor(pool, companyId, 'supplier');
      await pool.query(
        `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,total_amount,created_by)
         VALUES($1,$2,$3,$4,CURRENT_DATE,$5,$6)`, [id, companyId, number, supplier, amount, createdBy]);
      return id;
    }
    case 'credit_note': {
      const customer = await partyFor(pool, companyId, 'customer');
      await pool.query(
        `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,total_amount,created_by)
         VALUES($1,$2,$3,'customer',$4,CURRENT_DATE,$5,$6)`, [id, companyId, number, customer, amount, createdBy]);
      return id;
    }
    case 'payment': {
      const supplier = await partyFor(pool, companyId, 'supplier');
      await pool.query(
        `INSERT INTO supplier_payments(id,company_id,payment_number,supplier_id,payment_date,total_amount,created_by)
         VALUES($1,$2,$3,$4,CURRENT_DATE,$5,$6)`, [id, companyId, number, supplier, amount, createdBy]);
      return id;
    }
    case 'journal_entry': {
      // A journal entry has no amount column: its size is the sum of its debits.
      await pool.query(
        `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,created_by)
         VALUES($1,$2,$3,CURRENT_DATE,$4)`, [id, companyId, number, createdBy]);
      const glAccount = await glAccountFor(pool, companyId);
      await pool.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
         VALUES($1,$2,$3,$4,$5,0),($6,$2,$3,$4,0,$5)`,
        [crypto.randomUUID(), companyId, id, glAccount, amount, crypto.randomUUID()]);
      return id;
    }
  }
}

/** Remove every document this helper can plant, for a company's teardown. */
export async function deletePlantedDocuments(pool: Pool, companyIds: string[]): Promise<void> {
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [companyIds]);
  await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companyIds]);
}
