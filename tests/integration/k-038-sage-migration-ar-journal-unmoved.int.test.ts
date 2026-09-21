/**
 * K-038 LOW-2 — the "writing amount_paid does not move the AR journal" claim,
 * executed rather than read. The other two K-038 files mock
 * postCustomerInvoiceToGL; this one runs it for real, so a future change that
 * made the posting read `amount_paid` or `balance` would go red here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { commitARInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { mapSageARInvoices } from '@/modules/accounting/services/core/sageAutoImportService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = randomUUID();
const userId = randomUUID();
const tag = companyId.slice(0, 8);

const source = (num: string, amountDue: number) => ({
  ID: 1, CustomerId: 1, Customer: { Name: 'K-038 GL Customer' },
  DocumentNumber: num, Reference: num,
  Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
  Exclusive: 1000, Tax: 150, Total: 1150, AmountDue: amountDue, Status: 'x',
});

async function journalTotals(invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS c
     FROM gl_journal_lines l
     JOIN customer_invoices ci ON ci.gl_journal_entry_id = l.journal_entry_id
     WHERE ci.id = $1`, [invoiceId]);
  return { debit: Number(rows[0]!.d), credit: Number(rows[0]!.c) };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, `K-038 GL ${tag}`]);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k038gl.test.local`]);
  await pool.query('INSERT INTO customers(company_id,name,is_active) VALUES($1,$2,TRUE)', [companyId, 'K-038 GL Customer']);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES ($1,'1100','K038 AR','asset','receivable','debit',true,true),
            ($1,'4000','K038 Revenue','revenue','default_revenue','credit',true,true),
            ($1,'2300','K038 VAT Output','liability','vat_output','credit',true,true)`, [companyId]);
});

afterAll(async () => {
  await pool.query('UPDATE customer_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [companyId]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [companyId]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM customers WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
  await pool.end();
}, 60000);

describe('K-038 the AR journal is the same whatever the source had already settled', () => {
  it('posts a balanced journal for the FULL total on an unpaid and a part-paid invoice alike', async () => {
    const [open] = mapSageARInvoices([source(`${tag}-GL-OPEN`, 1150)]);
    const [part] = mapSageARInvoices([source(`${tag}-GL-PART`, 500)]);

    const a = await commitARInvoice(companyId, userId, open as never);
    const b = await commitARInvoice(companyId, userId, part as never);

    const openJournal = await journalTotals(a.invoiceId);
    const partJournal = await journalTotals(b.invoiceId);

    expect(openJournal.debit).toBeCloseTo(1150, 2);
    expect(openJournal.debit).toBeCloseTo(openJournal.credit, 2);
    // Part-paid: amount_paid 650, balance 500 — and the journal is IDENTICAL.
    expect(partJournal.debit).toBeCloseTo(1150, 2);
    expect(partJournal.debit).toBeCloseTo(partJournal.credit, 2);

    const { rows } = await pool.query(
      'SELECT amount_paid, balance FROM customer_invoices WHERE id=$1', [b.invoiceId]);
    expect(Number(rows[0]!.amount_paid)).toBe(650);
    expect(Number(rows[0]!.balance)).toBe(500);
  });
});
