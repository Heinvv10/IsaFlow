/**
 * K-031 — the on-screen / saved / filed VAT201 must come from the ledger.
 *
 * `generateVAT201` reads customer_invoices and supplier_invoices ONLY, so a
 * credit note posted to the ledger is invisible to it. The export and the MCP
 * tools already answer from the journal-derived `getVat201Report`; the route
 * and `submitVAT201ToSars` did not, so the figures a user saw, saved as a
 * draft submission and would file were higher than the books.
 *
 * `getLedgerVAT201` is the one adapter all three now go through. These tests
 * pin its agreement with the ledger, and pin the invoice-derived service still
 * disagreeing — that divergence is what the exceptions recon exists to report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generateVAT201 } from '../../src/modules/accounting/services/reports/vat201Service';
import { getLedgerVAT201 } from '../../src/modules/accounting/services/reports/vat201LedgerFields';
import { getVatPeriodLines } from '../../src/modules/accounting/services/reports/vatBoxBasisQuery';
import { deriveVatBoxes } from '../../src/modules/accounting/services/reports/vatBoxBasis';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();
const supplier = crypto.randomUUID();
const revenue = crypto.randomUUID();
const receivable = crypto.randomUUID();
const vatOutput = crypto.randomUUID();
const expense = crypto.randomUUID();
const payable = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const invoiceJournal = crypto.randomUUID();
const creditJournal = crypto.randomUUID();
const julyCreditJournal = crypto.randomUUID();
const billJournal = crypto.randomUUID();
const invoice = crypto.randomUUID();
const creditNote = crypto.randomUUID();
const julyCreditNote = crypto.randomUUID();
const bill = crypto.randomUUID();

// The other tenant's mirror of the same period — none of it may leak.
const otherRevenue = crypto.randomUUID();
const otherReceivable = crypto.randomUUID();
const otherVatOutput = crypto.randomUUID();
const otherJournal = crypto.randomUUID();

const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-30';

async function journal(id: string, companyId: string, entryNumber: string, date: string) {
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
       status,source,created_by)
     VALUES($1,$2,$3,$4,$5,'posted','manual',$6)`,
    [id, companyId, entryNumber, date, `K-031 ${entryNumber}`, user],
  );
}
async function line(
  entry: string, companyId: string, account: string,
  debit: number, credit: number, vatType: string | null,
) {
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,vat_type)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [entry, companyId, account, debit, credit, vatType],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [
    company, 'K-031 VAT source fixture', otherCompany, 'K-031 other tenant',
  ]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K-031 customer']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K-031 supplier']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$7,'K031-4000','Sales','revenue','sales','credit'),
           ($2,$7,'K031-1100','Trade receivables','asset','receivable','debit'),
           ($3,$7,'K031-2120','VAT output','liability','vat_output','credit'),
           ($4,$7,'K031-5000','Consumables','expense','operating_expense','debit'),
           ($5,$7,'K031-2100','Trade payables','liability','payable','credit'),
           ($6,$7,'K031-1140','VAT input','asset','vat_input','debit')`,
    [revenue, receivable, vatOutput, expense, payable, vatInput, company],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$4,'K031-4000','Sales','revenue','sales','credit'),
           ($2,$4,'K031-1100','Trade receivables','asset','receivable','debit'),
           ($3,$4,'K031-2120','VAT output','liability','vat_output','credit')`,
    [otherRevenue, otherReceivable, otherVatOutput, otherCompany],
  );

  // Sales invoice R10 000 + R1 500 VAT, posted.
  await journal(invoiceJournal, company, 'K031-INV', '2026-06-15');
  await line(invoiceJournal, company, receivable, 11500, 0, null);
  await line(invoiceJournal, company, revenue, 0, 10000, 'standard');
  await line(invoiceJournal, company, vatOutput, 0, 1500, 'standard');
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-INV-1',$3,'2026-06-15',10000,1500,15,11500,'sent',$4,$5)`,
    [invoice, company, customer, invoiceJournal, user],
  );

  // Approved credit note R1 000 + R150 VAT against it, posted to the ledger.
  await journal(creditJournal, company, 'K031-CN', '2026-06-15');
  await line(creditJournal, company, revenue, 1000, 0, 'standard');
  await line(creditJournal, company, vatOutput, 150, 0, 'standard');
  await line(creditJournal, company, receivable, 0, 1150, null);
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,
       subtotal,tax_amount,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-CN-1','customer',$3,'2026-06-15',1000,150,1150,'approved',$4,$5)`,
    [creditNote, company, customer, creditJournal, user],
  );

  // A JULY credit note. Outside the period — it must not move June.
  await journal(julyCreditJournal, company, 'K031-CN-JUL', '2026-07-02');
  await line(julyCreditJournal, company, revenue, 4000, 0, 'standard');
  await line(julyCreditJournal, company, vatOutput, 600, 0, 'standard');
  await line(julyCreditJournal, company, receivable, 0, 4600, null);
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,
       subtotal,tax_amount,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-CN-2','customer',$3,'2026-07-02',4000,600,4600,'approved',$4,$5)`,
    [julyCreditNote, company, customer, julyCreditJournal, user],
  );

  // Supplier bill R2 000 + R300 input VAT.
  await journal(billJournal, company, 'K031-BILL', '2026-06-20');
  await line(billJournal, company, expense, 2000, 0, 'standard');
  await line(billJournal, company, vatInput, 300, 0, 'standard');
  await line(billJournal, company, payable, 0, 2300, null);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-BILL-1',$3,'2026-06-20',2000,300,15,2300,'approved',$4,$5)`,
    [bill, company, supplier, billJournal, user],
  );

  // The other tenant's June sale — R50 000 + R7 500. Must never appear.
  await journal(otherJournal, otherCompany, 'K031-OTHER', '2026-06-10');
  await line(otherJournal, otherCompany, otherReceivable, 57500, 0, null);
  await line(otherJournal, otherCompany, otherRevenue, 0, 50000, 'standard');
  await line(otherJournal, otherCompany, otherVatOutput, 0, 7500, 'standard');
});

afterAll(async () => {
  const ids = [company, otherCompany];
  try {
    await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
  } finally {
    await pool.end();
  }
});

describe('K-031 VAT201 source', () => {
  it('files the same output VAT the ledger-derived VAT201 reports', async () => {
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);
    const { lines } = await getVatPeriodLines(company, PERIOD_START, PERIOD_END);
    const ledger = deriveVatBoxes(lines);

    expect(ledger.outputTax).toBeCloseTo(1350, 2);   // 1500 invoiced less 150 credited
    expect(filed.field5_outputVAT).toBeCloseTo(ledger.outputTax, 2);
    expect(filed.field1_standardRatedSupplies).toBeCloseTo(9000, 2);
  });

  it('reports input VAT and the net from the ledger, and the input fields foot to the total', async () => {
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);

    expect(filed.field10_totalInputVAT).toBeCloseTo(300, 2);
    expect(
      filed.field6_capitalGoods + filed.field7_otherGoods + filed.field8_services + filed.field9_imports,
    ).toBeCloseTo(filed.field10_totalInputVAT, 2);
    expect(filed.field11_vatPayableOrRefundable).toBeCloseTo(1350 - 300, 2);
  });

  it('leaves the invoice-derived service disagreeing — that gap is the exceptions finding', async () => {
    const invoiceDerived = await generateVAT201(company, PERIOD_START, PERIOD_END);
    expect(invoiceDerived.field5_outputVAT).toBeCloseTo(1500, 2);
  });

  it('ignores a credit note dated outside the period', async () => {
    // The July credit note is R600 of output VAT. June must still be R1 350.
    const june = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);
    expect(june.field5_outputVAT).toBeCloseTo(1350, 2);

    const july = await getLedgerVAT201(company, '2026-07-01', '2026-07-31');
    expect(july.field5_outputVAT).toBeCloseTo(-600, 2);
  });

  it('never reads another tenant into the return', async () => {
    const ours = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);
    expect(ours.field1_standardRatedSupplies).toBeCloseTo(9000, 2);   // not 59 000
    expect(ours.field5_outputVAT).toBeCloseTo(1350, 2);               // not 8 850

    const theirs = await getLedgerVAT201(otherCompany, PERIOD_START, PERIOD_END);
    expect(theirs.field5_outputVAT).toBeCloseTo(7500, 2);
    expect(theirs.field10_totalInputVAT).toBeCloseTo(0, 2);
  });
});
