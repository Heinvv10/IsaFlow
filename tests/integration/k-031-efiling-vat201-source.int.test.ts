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
import { getLedgerVAT201, evaluateVat201Filability } from '../../src/modules/accounting/services/reports/vat201LedgerFields';
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
const exportJournal = crypto.randomUUID();
const exemptJournal = crypto.randomUUID();
const capitalJournal = crypto.randomUUID();
const exportInvoice = crypto.randomUUID();
const exemptInvoice = crypto.randomUUID();
const mixedInvoice = crypto.randomUUID();
const MIXED_START = '2026-08-01';
const MIXED_END = '2026-08-31';
const capitalAsset = crypto.randomUUID();
const capitalBill = crypto.randomUUID();
const servicesJournal = crypto.randomUUID();
const servicesBill = crypto.randomUUID();
const mixedInvoiceJournal = crypto.randomUUID();
const mixedExemptJournal = crypto.randomUUID();
const mixedExemptInvoice = crypto.randomUUID();
const draftExportJournal = crypto.randomUUID();
const draftExportInvoice = crypto.randomUUID();
const uncodedExportJournal = crypto.randomUUID();
const uncodedExportInvoice = crypto.randomUUID();
const EXEMPT_START = '2026-09-01';
const EXEMPT_END = '2026-09-30';
const DRAFT_START = '2026-10-01';
const DRAFT_END = '2026-10-31';

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
     VALUES($1,$2,'K031-1500','Equipment','asset','fixed_asset','debit')`,
    [capitalAsset, company],
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

  // A zero-rated EXPORT of R20 000. No VAT leg at all — invisible to the
  // journal-derived basis, which is why field 2 comes from the documents.
  await journal(exportJournal, company, 'K031-EXP', '2026-06-18');
  await line(exportJournal, company, receivable, 20000, 0, null);
  await line(exportJournal, company, revenue, 0, 20000, 'export');
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-EXP-1',$3,'2026-06-18',20000,0,0,20000,'sent',$4,$5)`,
    [exportInvoice, company, customer, exportJournal, user],
  );

  // An EXEMPT supply of R5 000. Also no VAT leg.
  await journal(exemptJournal, company, 'K031-EXM', '2026-06-19');
  await line(exemptJournal, company, receivable, 5000, 0, null);
  await line(exemptJournal, company, revenue, 0, 5000, 'exempt');
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-EXM-1',$3,'2026-06-19',5000,0,0,5000,'sent',$4,$5)`,
    [exemptInvoice, company, customer, exemptJournal, user],
  );

  // Capital goods purchase R8 000 + R1 200 input VAT — field 6 and its base.
  await journal(capitalJournal, company, 'K031-CAP', '2026-06-21');
  await line(capitalJournal, company, capitalAsset, 8000, 0, 'capital_goods');
  await line(capitalJournal, company, vatInput, 1200, 0, 'capital_goods');
  await line(capitalJournal, company, payable, 0, 9200, null);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-CAP-1',$3,'2026-06-21',8000,1200,15,9200,'approved',$4,$5)`,
    [capitalBill, company, supplier, capitalJournal, user],
  );

  // A SERVICES purchase R4 000 + R600, with the line item classification the
  // journal vocabulary has no word for — the only basis for field 8.
  await journal(servicesJournal, company, 'K031-SVC', '2026-06-22');
  await line(servicesJournal, company, expense, 4000, 0, 'standard');
  await line(servicesJournal, company, vatInput, 600, 0, 'standard');
  await line(servicesJournal, company, payable, 0, 4600, null);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-SVC-1',$3,'2026-06-22',4000,600,15,4600,'approved',$4,$5)`,
    [servicesBill, company, supplier, servicesJournal, user],
  );
  await pool.query(
    `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,
       tax_rate,tax_amount,line_total,vat_classification)
     VALUES($1,'Consulting',1,4000,15,600,4000,'services')`,
    [servicesBill],
  );

  // AUGUST, its own period: ONE journal carrying R1 000 standard (R150 VAT) and
  // R500 zero-rated. The ledger basis apportions base pro-rata by tax, so the
  // untaxed R500 lands on field 1 and the 15% check must catch it.
  await journal(mixedInvoiceJournal, company, 'K031-MIX', '2026-08-10');
  await line(mixedInvoiceJournal, company, receivable, 1650, 0, null);
  await line(mixedInvoiceJournal, company, revenue, 0, 1000, 'standard');
  await line(mixedInvoiceJournal, company, revenue, 0, 500, 'zero_rated');
  await line(mixedInvoiceJournal, company, vatOutput, 0, 150, 'standard');
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-MIX-1',$3,'2026-08-10',1500,150,15,1650,'sent',$4,$5)`,
    [mixedInvoice, company, customer, mixedInvoiceJournal, user],
  );

  // SEPTEMBER: one invoice, one journal, R1 000 standard + R500 EXEMPT.
  // Reading one VAT code per document put the whole R1 500 in field 3 while
  // the ledger put it in field 1 — R3 000 declared for an R1 500 invoice.
  await journal(mixedExemptJournal, company, 'K031-MIXEX', '2026-09-12');
  await line(mixedExemptJournal, company, receivable, 1650, 0, null);
  await line(mixedExemptJournal, company, revenue, 0, 1000, 'standard');
  await line(mixedExemptJournal, company, revenue, 0, 500, 'exempt');
  await line(mixedExemptJournal, company, vatOutput, 0, 150, 'standard');
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-MIXEX-1',$3,'2026-09-12',1500,150,15,1650,'sent',$4,$5)`,
    [mixedExemptInvoice, company, customer, mixedExemptJournal, user],
  );

  // OCTOBER: a DRAFT export invoice on a DRAFT journal, plus a posted export
  // invoice whose revenue leg carries no VAT code at all.
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,
       status,source,created_by)
     VALUES($1,$2,'K031-DRAFT','2026-10-05','K031 draft export','draft','manual',$3)`,
    [draftExportJournal, company, user],
  );
  await line(draftExportJournal, company, receivable, 9000, 0, null);
  await line(draftExportJournal, company, revenue, 0, 9000, 'export');
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-DRAFT-1',$3,'2026-10-05',9000,0,0,9000,'draft',$4,$5)`,
    [draftExportInvoice, company, customer, draftExportJournal, user],
  );

  await journal(uncodedExportJournal, company, 'K031-UNCODED', '2026-10-06');
  await line(uncodedExportJournal, company, receivable, 7000, 0, null);
  await line(uncodedExportJournal, company, revenue, 0, 7000, null);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,invoice_date,
       subtotal,tax_amount,tax_rate,total_amount,status,gl_journal_entry_id,created_by)
     VALUES($1,$2,'K031-UNCODED-1',$3,'2026-10-06',7000,0,0,7000,'sent',$4,$5)`,
    [uncodedExportInvoice, company, customer, uncodedExportJournal, user],
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
    await pool.query(
      'DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))',
      [ids],
    );
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

  it('reports zero-rated and exempt supplies, which have no VAT leg to derive them from', async () => {
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);

    // Both journals post no VAT control leg, so getVat201Report never selects
    // them. Reading fields 2 and 3 off its boxes filed R0 of export turnover.
    expect(filed.field2_zeroRatedSupplies).toBeCloseTo(20000, 2);
    expect(filed.field3_exemptSupplies).toBeCloseTo(5000, 2);
    // ...and they must not also be counted as standard-rated.
    expect(filed.field1_standardRatedSupplies).toBeCloseTo(9000, 2);
  });

  it('splits input VAT across capital goods, services and other, footing to field10', async () => {
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);

    expect(filed.field6_capitalGoods).toBeCloseTo(1200, 2);   // ledger, box 14
    expect(filed.field8_services).toBeCloseTo(600, 2);        // documents, line classification
    expect(filed.field9_imports).toBeCloseTo(0, 2);
    expect(filed.field4_totalImports).toBeCloseTo(0, 2);
    expect(filed.field7_otherGoods).toBeCloseTo(300, 2);      // the R2 000 consumables bill
    expect(filed.field10_totalInputVAT).toBeCloseTo(2100, 2); // 300 + 1200 + 600
    expect(
      filed.field6_capitalGoods + filed.field7_otherGoods + filed.field8_services + filed.field9_imports,
    ).toBeCloseTo(filed.field10_totalInputVAT, 2);
    expect(filed.field11_vatPayableOrRefundable).toBeCloseTo(1350 - 2100, 2);
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
    expect(ours.field2_zeroRatedSupplies).toBeCloseTo(20000, 2);

    const theirs = await getLedgerVAT201(otherCompany, PERIOD_START, PERIOD_END);
    expect(theirs.field5_outputVAT).toBeCloseTo(7500, 2);
    expect(theirs.field10_totalInputVAT).toBeCloseTo(0, 2);
    expect(theirs.field2_zeroRatedSupplies).toBeCloseTo(0, 2);
    expect(theirs.field3_exemptSupplies).toBeCloseTo(0, 2);
  });

  it('a clean period is filable', async () => {
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);
    expect(filed.rateCheck.ties).toBe(true);
    expect(evaluateVat201Filability(filed)).toEqual({ filable: true, reason: null });
  });

  it('splits a mixed zero-rated invoice by line instead of declaring it twice', async () => {
    // ONE journal: R1 000 standard (R150 VAT) + R500 zero-rated, R1 500 invoice.
    // deriveVatBoxes apportions the whole R1 500 base onto the taxed box, so
    // field 1 gives the R500 back to field 2 rather than declaring R2 000.
    const mixed = await getLedgerVAT201(company, MIXED_START, MIXED_END);

    expect(mixed.field1_standardRatedSupplies).toBeCloseTo(1000, 2);
    expect(mixed.field2_zeroRatedSupplies).toBeCloseTo(500, 2);
    expect(mixed.field3_exemptSupplies).toBeCloseTo(0, 2);
    expect(mixed.field5_outputVAT).toBeCloseTo(150, 2);
    // R1 000 x 15% = R150. Declared and implied now agree, so it is filable.
    expect(
      mixed.field1_standardRatedSupplies + mixed.field2_zeroRatedSupplies,
    ).toBeCloseTo(1500, 2);
    expect(evaluateVat201Filability(mixed)).toEqual({ filable: true, reason: null });
  });

  it('splits a mixed EXEMPT invoice by line — the double count was R3 000 for R1 500', async () => {
    const mixed = await getLedgerVAT201(company, EXEMPT_START, EXEMPT_END);

    expect(mixed.field1_standardRatedSupplies).toBeCloseTo(1000, 2);
    expect(mixed.field3_exemptSupplies).toBeCloseTo(500, 2);
    expect(mixed.field2_zeroRatedSupplies).toBeCloseTo(0, 2);
    expect(
      mixed.field1_standardRatedSupplies + mixed.field3_exemptSupplies,
    ).toBeCloseTo(1500, 2);
    expect(mixed.field5_outputVAT).toBeCloseTo(150, 2);
  });

  it('ignores an unposted document and still reads a revenue leg with no VAT code', async () => {
    // October holds a DRAFT R9 000 export on a draft journal, and a POSTED
    // R7 000 export invoice whose revenue leg carries no VAT code at all.
    const october = await getLedgerVAT201(company, DRAFT_START, DRAFT_END);

    expect(october.field2_zeroRatedSupplies).toBeCloseTo(7000, 2);   // not 16 000
    expect(october.field1_standardRatedSupplies).toBeCloseTo(0, 2);
    expect(october.field5_outputVAT).toBeCloseTo(0, 2);
  });

  it('refuses to file an input breakdown that contradicts its own total', async () => {
    // The ledger claims R2 100 of input tax; the documents classify R9 000 of
    // it as services, so the field 7 remainder would be negative.
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);
    const contradicted = { ...filed, field8_services: 9000, field7_otherGoods: -7900 };

    const gate = evaluateVat201Filability(contradicted);
    expect(gate.filable).toBe(false);
    expect(gate.reason).toContain('services');
  });

  it('tolerates a variance proportional to the tax declared, and refuses a material one', async () => {
    const filed = await getLedgerVAT201(company, PERIOD_START, PERIOD_END);

    // Output variance is recomputed from field1 x 15% against field5.
    // R2 out on R1 350 of output tax is under the 0.5% bar (R6.75), so it is
    // filable — vatBoxBasis's R1 absolute tolerance would block it forever.
    const small = { ...filed, field5_outputVAT: filed.field5_outputVAT + 2 };
    expect(evaluateVat201Filability(small)).toEqual({ filable: true, reason: null });

    // R75 out on the same R1 350 is 5.6% — refused.
    const material = { ...filed, field5_outputVAT: filed.field5_outputVAT + 75 };
    expect(evaluateVat201Filability(material).filable).toBe(false);

    // And the input side still comes from the report's own variance.
    const badInput = { ...filed, rateCheck: { ...filed.rateCheck, inputVariance: 900 } };
    expect(evaluateVat201Filability(badInput).filable).toBe(false);
  });

  it('refuses to file a period whose supply values are negative', async () => {
    // July holds only the R4 000 credit note, so field 1 is -4 000.
    const july = await getLedgerVAT201(company, '2026-07-01', '2026-07-31');
    expect(july.field1_standardRatedSupplies).toBeCloseTo(-4000, 2);

    const gate = evaluateVat201Filability(july);
    expect(gate.filable).toBe(false);
    expect(gate.reason).toContain('negative');
  });
});
