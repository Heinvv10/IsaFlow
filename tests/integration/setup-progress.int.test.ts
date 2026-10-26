// tests/integration/setup-progress.int.test.ts
//
// Real-PG proof for the Home setup checklist (master-plan W1 PR C): every probe is
// scoped to the company, a row flips exactly its own fact, and a draft or cancelled
// document never counts. Company B holds a row in every probed table, so a probe that
// lost its company_id (or reads the wrong table) goes red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getSetupProgress, probeSetupFacts, type SetupFacts } from '@/modules/accounting/services/core/setupProgressService';

const DATABASE_URL = process.env.DATABASE_URL;
const A = '00000000-0000-0000-0000-0000000c0a01';
const B = '00000000-0000-0000-0000-0000000c0b01';
const A_CUSTOMER = '00000000-0000-0000-0000-0000000c0a02';
const B_CUSTOMER = '00000000-0000-0000-0000-0000000c0b02';
const A_SUPPLIER = '00000000-0000-0000-0000-0000000c0a03';
const B_SUPPLIER = '00000000-0000-0000-0000-0000000c0b03';
const B_BANK = '00000000-0000-0000-0000-0000000c0b04';
const USER = '00000000-0000-0000-0000-0000000c0f01';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('setup progress probes', () => {
  let admin: Pool;

  async function cleanup() {
    for (const t of ['payroll_run_headers', 'payroll_employees', 'customer_payments', 'customer_invoices',
      'supplier_invoices', 'bank_transactions', 'gl_journal_entries', 'fiscal_periods', 'fiscal_years', 'gl_accounts', 'customers', 'suppliers']) {
      await admin.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
    }
    await admin.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
  }

  const customerInvoice = (company: string, customer: string, n: string, status: string) => admin.query(
    `INSERT INTO customer_invoices (company_id, customer_id, invoice_number, status, created_by)
     VALUES ($1,$2,$3,$4,'setup-test')`, [company, customer, n, status]);
  const receipt = (company: string, customer: string, status: string) => admin.query(
    `INSERT INTO customer_payments (company_id, client_id, payment_date, total_amount, created_by, status)
     VALUES ($1,$2,'2026-01-01',10,$3,$4)`, [company, customer, USER, status]);
  const supplierInvoice = (company: string, supplier: string, n: string, status: string) => admin.query(
    `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, created_by, status)
     VALUES ($1,$2,$3,'2026-01-01',$4,$5)`, [company, supplier, n, USER, status]);
  const payRun = (company: string, month: number, status: string) => admin.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1,$2,2026,$3)`,
    [company, month, status]);
  const employee = (company: string, n: string, status: string) => admin.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
     VALUES ($1,$2,'Setup','Employee','2026-01-01',$3)`, [company, n, status]);

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup();
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'Setup Fixture A',true),($2,'Setup Fixture B',true)`, [A, B]);
    await admin.query(`INSERT INTO customers (id, company_id, name) VALUES ($1,$2,'B cust')`, [B_CUSTOMER, B]);
    await admin.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,'B supp')`, [B_SUPPLIER, B]);
    // Company B holds a counting row in EVERY probed table; A holds none yet.
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,'SP1000','Bank','asset','bank','debit',true)`, [B_BANK, B]);
    await admin.query(
      `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount) VALUES ($1,$2,'2026-01-01',5)`, [B, B_BANK]);
    const [{ id: yearId }] = (await admin.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1,2026,'2026-01-01','2026-12-31') RETURNING id`, [B])).rows;
    await admin.query(
      `INSERT INTO fiscal_periods (company_id, fiscal_year_id, period_name, period_number, fiscal_year, start_date, end_date)
       VALUES ($1,$2,'P1',1,2026,'2026-01-01','2026-12-31')`, [B, yearId]);
    await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, source, reference)
       VALUES ($1,'2026-01-01',$2,'posted','manual','opening_balance')`, [B, USER]);
    await customerInvoice(B, B_CUSTOMER, 'B-1', 'sent');
    await receipt(B, B_CUSTOMER, 'confirmed');
    await supplierInvoice(B, B_SUPPLIER, 'B-S1', 'approved');
    await employee(B, 'B1', 'active');
    await payRun(B, 1, 'paid');
    await admin.query(`UPDATE companies SET paye_reference_number='7000000000', vat_number='4000000000' WHERE id=$1`, [B]);
  });

  afterAll(async () => {
    try { await cleanup(); } finally { await admin.end(); }
  });

  it("company B's rows in every probed table never reach company A", async () => {
    const a = await probeSetupFacts(A);
    const b = await probeSetupFacts(B);
    const off = Object.entries(a).filter(([k, v]) => v === true && k !== 'vatVendor').map(([k]) => k);
    expect(off).toEqual([]);
    expect(b).toMatchObject({
      hasCustomers: true, hasSuppliers: true, hasBankAccount: true, hasBankTransactions: true,
      hasCustomerInvoices: true, hasReceipts: true, hasSupplierInvoices: true, hasEmployees: true,
      hasPayrollRuns: true, hasFiscalPeriods: true, hasOpeningBalances: true, payeReference: true, vatNumber: true,
    });
  });

  it('each A row flips exactly its own fact', async () => {
    const cases: Array<[keyof SetupFacts, () => Promise<unknown>]> = [
      ['hasCustomers', () => admin.query(`INSERT INTO customers (id, company_id, name) VALUES ($1,$2,'A cust')`, [A_CUSTOMER, A])],
      ['hasSuppliers', () => admin.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,'A supp')`, [A_SUPPLIER, A])],
      ['hasCustomerInvoices', () => customerInvoice(A, A_CUSTOMER, 'A-1', 'sent')],
      ['hasReceipts', () => receipt(A, A_CUSTOMER, 'confirmed')],
      ['hasSupplierInvoices', () => supplierInvoice(A, A_SUPPLIER, 'A-S1', 'approved')],
      ['hasEmployees', () => employee(A, 'A1', 'active')],
      ['hasPayrollRuns', () => payRun(A, 1, 'approved')],
    ];
    for (const [fact, insert] of cases) {
      const before = await probeSetupFacts(A);
      expect(before[fact], `${fact} before`).toBe(false);
      await insert();
      const after = await probeSetupFacts(A);
      expect(after[fact], `${fact} after`).toBe(true);
      expect(Object.keys(after).filter((k) => (after as never)[k] !== (before as never)[k]), `${fact} moved others`).toEqual([fact]);
    }
  });

  it('drafts, cancelled documents, and terminated employees do not count', async () => {
    await admin.query('DELETE FROM customer_invoices WHERE company_id=$1', [A]);
    await admin.query('DELETE FROM customer_payments WHERE company_id=$1', [A]);
    await admin.query('DELETE FROM supplier_invoices WHERE company_id=$1', [A]);
    await admin.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [A]);
    await admin.query('DELETE FROM payroll_employees WHERE company_id=$1', [A]);
    await customerInvoice(A, A_CUSTOMER, 'A-D', 'draft');
    await customerInvoice(A, A_CUSTOMER, 'A-C', 'cancelled');
    await receipt(A, A_CUSTOMER, 'draft');
    await receipt(A, A_CUSTOMER, 'cancelled');
    await supplierInvoice(A, A_SUPPLIER, 'A-SD', 'draft');
    await supplierInvoice(A, A_SUPPLIER, 'A-SC', 'cancelled');
    await payRun(A, 2, 'draft');
    await payRun(A, 3, 'cancelled');
    await employee(A, 'A9', 'terminated');
    const a = await probeSetupFacts(A);
    expect([a.hasCustomerInvoices, a.hasReceipts, a.hasSupplierInvoices, a.hasPayrollRuns, a.hasEmployees])
      .toEqual([false, false, false, false, false]);
    const p = await getSetupProgress(A);
    expect(p.modules.some((m) => m.id === 'payroll')).toBe(false);
  });

  it('PAYE reference is trimmed; a whitespace-only value is not set', async () => {
    await admin.query(`UPDATE companies SET paye_reference_number='   ' WHERE id=$1`, [A]);
    expect((await probeSetupFacts(A)).payeReference).toBe(false);
    await admin.query(`UPDATE companies SET paye_reference_number=' 712345678 ' WHERE id=$1`, [A]);
    expect((await probeSetupFacts(A)).payeReference).toBe(true);
  });

  it("vat_period 'none' removes the Tax checklist", async () => {
    await admin.query(`UPDATE companies SET vat_period='none' WHERE id=$1`, [A]);
    expect((await getSetupProgress(A)).modules.some((m) => m.id === 'tax')).toBe(false);
    await admin.query(`UPDATE companies SET vat_period='bi-monthly' WHERE id=$1`, [A]);
    expect((await getSetupProgress(A)).modules.some((m) => m.id === 'tax')).toBe(true);
  });

  it('an unknown company yields all-false facts with no error', async () => {
    const f = await probeSetupFacts('00000000-0000-0000-0000-0000000c0e99');
    expect(Object.entries(f).filter(([k, v]) => v === true && k !== 'vatVendor')).toEqual([]);
  });
});
