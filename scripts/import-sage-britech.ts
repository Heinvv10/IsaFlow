/**
 * Import Sage data into ISAFlow for Brightsphere Technologies
 * Usage: DATABASE_URL="..." bun run /tmp/sage-pull-britech/import-sage-data.ts
 */
import { createSql } from './_pg';
import { readFileSync } from 'fs';

const sql = createSql();
const CID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';

const USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2'; // hein@isaflow.co.za
const CAT_TYPE: Record<number, string> = { 1:'revenue', 2:'expense', 3:'revenue', 4:'expense', 5:'asset', 6:'asset', 7:'liability', 8:'liability', 9:'equity', 10:'expense' };
const CAT_SUB: Record<number, string> = { 1:'sales', 2:'cost_of_sales', 3:'other_income', 4:'operating_expenses', 5:'fixed_assets', 6:'current_assets', 7:'long_term_liabilities', 8:'current_liabilities', 9:'equity', 10:'tax' };
const CAT_NORM: Record<number, string> = { 1:'credit', 2:'debit', 3:'credit', 4:'debit', 5:'debit', 6:'debit', 7:'credit', 8:'credit', 9:'credit', 10:'debit' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = JSON.parse(readFileSync('/home/hein/Downloads/sage-complete-export.json', 'utf-8')) as any;

async function importAccounts() {
  console.log(`\nImporting ${data.accounts.length} accounts...`);
  let ok = 0, errs = 0;
  for (const a of data.accounts) {
    const catId = a.Category?.ID ?? 4;
    const code = a.ID > 0 ? String(a.ID) : `SYS${Math.abs(a.ID)}`;
    const type = CAT_TYPE[catId] || 'expense';
    const sub = CAT_SUB[catId] || 'operating_expenses';
    const norm = CAT_NORM[catId] || 'debit';
    const desc = a.Description || a.Category?.Description || '';
    const order = a.Category?.Order ?? 0;
    try {
      await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account, description, display_order, imported_from)
        VALUES (${CID}::UUID, ${code}, ${a.Name}, ${type}, ${sub}, ${norm}, ${a.Active}, ${a.AccountType === 2}, ${desc}, ${order}, 'sage_cloud')
        ON CONFLICT DO NOTHING`;
      ok++;
    } catch (e: any) { errs++; console.error(`  ERR ${a.Name}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Accounts: ${ok} imported, ${errs} errors`);
}

async function importCustomers() {
  console.log(`\nImporting ${data.customers.length} customers...`);
  let ok = 0;
  for (const c of data.customers) {
    try {
      await sql`INSERT INTO customers (company_id, name, email, phone, vat_number, contact_person, credit_limit, is_active, opening_balance, accepts_electronic_invoices, auto_allocate_receipts, mobile)
        VALUES (${CID}::UUID, ${c.Name}, ${c.Email || null}, ${c.Telephone || null}, ${c.TaxReference || null}, ${c.ContactName || null}, ${c.CreditLimit || 0}, ${c.Active}, ${c.Balance || 0}, ${c.AcceptsElectronicInvoices || false}, ${c.AutoAllocateToOldestInvoice || false}, ${c.Mobile || null})`;
      ok++;
    } catch (e: any) { console.error(`  ERR ${c.Name}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Customers: ${ok} imported`);
}

async function importSuppliers() {
  console.log(`\nImporting ${data.suppliers.length} suppliers...`);
  let ok = 0;
  for (const s of data.suppliers) {
    try {
      await sql`INSERT INTO suppliers (company_id, name, email, phone, vat_number, contact_person, is_active, opening_balance, mobile, fax, web_address, auto_allocate_payments)
        VALUES (${CID}::UUID, ${s.Name}, ${s.Email || null}, ${s.Telephone || null}, ${s.TaxReference || null}, ${s.ContactName || null}, ${s.Active}, ${s.Balance || 0}, ${s.Mobile || null}, ${s.Fax || null}, ${s.WebAddress || null}, ${s.AutoAllocateToOldestInvoice || false})`;
      ok++;
    } catch (e: any) { console.error(`  ERR ${s.Name}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Suppliers: ${ok} imported`);
}

async function importARInvoices() {
  console.log(`\nImporting ${data.arInvoices.length} AR invoices...`);
  // First build a customer name→id map
  const custRows = await sql`SELECT id, name FROM customers WHERE company_id = ${CID}::UUID`;
  const custMap = new Map(custRows.map((r: any) => [r.name.toLowerCase(), r.id]));

  // Get the default AR account (Trade Receivables / revenue type)
  const arAcct = await sql`SELECT id FROM gl_accounts WHERE company_id = ${CID}::UUID AND account_name = 'Trade Receivables' LIMIT 1`;
  const arAccountId = arAcct[0]?.id;

  // Get a sales account for line items
  const salesAcct = await sql`SELECT id FROM gl_accounts WHERE company_id = ${CID}::UUID AND account_name = 'Other Sales' LIMIT 1`;
  const salesAccountId = salesAcct[0]?.id;

  let ok = 0, skip = 0;
  for (const inv of data.arInvoices) {
    const custName = inv.Customer?.Name || '';
    const customerId = custMap.get(custName.toLowerCase());
    if (!customerId) { skip++; continue; }

    const invDate = inv.Date?.split('T')[0] || null;
    const dueDate = inv.DueDate?.split('T')[0] || null;
    const status = inv.AmountDue === 0 ? 'paid' : inv.Status === 'Draft' ? 'draft' : 'approved';

    try {
      await sql`INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, status, notes, created_by)
        VALUES (${CID}::UUID, ${customerId}::UUID, ${inv.DocumentNumber}, ${invDate}::DATE, ${dueDate}::DATE,
          ${inv.Exclusive || 0}, ${inv.Tax || 0}, ${inv.Total || 0}, ${(inv.Total || 0) - (inv.AmountDue || 0)},
          ${status}, ${inv.Reference ? 'Sage ref: ' + inv.Reference : null}, ${USER_ID}::UUID)
        ON CONFLICT DO NOTHING`;
      ok++;
    } catch (e: any) { console.error(`  ERR ${inv.DocumentNumber}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  AR Invoices: ${ok} imported, ${skip} skipped (no customer match)`);
}

async function importAPInvoices() {
  console.log(`\nImporting ${data.apInvoices.length} AP invoices...`);
  const suppRows = await sql`SELECT id, name FROM suppliers WHERE company_id = ${CID}::UUID`;
  const suppMap = new Map(suppRows.map((r: any) => [r.name.toLowerCase(), r.id]));

  let ok = 0, skip = 0;
  for (const inv of data.apInvoices) {
    const suppName = inv.Supplier?.Name || '';
    const supplierId = suppMap.get(suppName.toLowerCase());
    if (!supplierId) { skip++; continue; }

    const invDate = inv.Date?.split('T')[0] || null;
    const dueDate = inv.DueDate?.split('T')[0] || null;
    const status = inv.AmountDue === 0 ? 'paid' : 'approved';

    try {
      await sql`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, status, reference, created_by)
        VALUES (${CID}::UUID, ${supplierId}::UUID, ${inv.DocumentNumber}, ${invDate}::DATE, ${dueDate}::DATE,
          ${inv.Exclusive || 0}, ${inv.Tax || 0}, ${inv.Total || 0}, ${(inv.Total || 0) - (inv.AmountDue || 0)},
          ${status}, ${inv.Reference || null}, ${USER_ID}::UUID)
        ON CONFLICT DO NOTHING`;
      ok++;
    } catch (e: any) { console.error(`  ERR ${inv.DocumentNumber}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  AP Invoices: ${ok} imported, ${skip} skipped (no supplier match)`);
}

// Also load bank transactions
const bankTxnData = JSON.parse(readFileSync('/home/hein/Downloads/sage-bank-transactions.json', 'utf-8')) as any[];

async function importCustomerReceipts() {
  console.log(`\nImporting ${data.receipts.length} customer receipts...`);
  const custRows = await sql`SELECT id, name FROM customers WHERE company_id = ${CID}::UUID`;
  const custMap = new Map(custRows.map((r: any) => [r.name.toLowerCase(), r.id]));

  let ok = 0, skip = 0;
  for (const r of data.receipts) {
    const custName = r.Customer?.Name || '';
    const customerId = custMap.get(custName.toLowerCase());
    if (!customerId) { skip++; continue; }

    const payDate = r.Date?.split('T')[0] || null;
    try {
      await sql`INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date,
        total_amount, payment_method, bank_reference, description, status, created_by)
        VALUES (${CID}::UUID, ${customerId}::UUID, ${r.DocumentNumber}, ${payDate}::DATE,
          ${r.Total || 0}, 'eft', ${r.Reference || null},
          ${r.Description || r.Comments || null}, 'confirmed', ${USER_ID}::UUID)
        ON CONFLICT DO NOTHING`;
      ok++;
    } catch (e: any) { console.error(`  ERR ${r.DocumentNumber}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Customer Receipts: ${ok} imported, ${skip} skipped`);
}

async function importSupplierPayments() {
  console.log(`\nImporting ${data.supplierPayments.length} supplier payments...`);
  const suppRows = await sql`SELECT id, name FROM suppliers WHERE company_id = ${CID}::UUID`;
  const suppMap = new Map(suppRows.map((r: any) => [r.name.toLowerCase(), r.id]));

  let ok = 0, skip = 0;
  for (const p of data.supplierPayments) {
    const suppName = p.Supplier?.Name || '';
    const supplierId = suppMap.get(suppName.toLowerCase());
    if (!supplierId) { skip++; continue; }

    const payDate = p.Date?.split('T')[0] || null;
    try {
      await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_number, payment_date,
        total_amount, payment_method, reference, description, status, created_by)
        VALUES (${CID}::UUID, ${supplierId}::UUID, ${p.DocumentNumber}, ${payDate}::DATE,
          ${p.Total || 0}, 'eft', ${p.Reference || null},
          ${p.Description || p.Comments || null}, 'processed', ${USER_ID}::UUID)
        ON CONFLICT DO NOTHING`;
      ok++;
    } catch (e: any) { console.error(`  ERR ${p.DocumentNumber}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Supplier Payments: ${ok} imported, ${skip} skipped`);
}

async function importJournalEntries() {
  console.log(`\nImporting ${data.journalEntries.length} journal entries...`);
  // Build account ID map (Sage account ID → ISAFlow gl_account UUID)
  const acctRows = await sql`SELECT id, account_code FROM gl_accounts WHERE company_id = ${CID}::UUID`;
  const acctMap = new Map(acctRows.map((r: any) => [r.account_code, r.id]));

  let ok = 0, errs = 0;
  for (const je of data.journalEntries) {
    const entryDate = je.Date?.split('T')[0] || null;
    const sageAcctId = String(je.AccountId > 0 ? je.AccountId : `SYS${Math.abs(je.AccountId)}`);
    const sageContraId = String(je.ContraAccountId > 0 ? je.ContraAccountId : `SYS${Math.abs(je.ContraAccountId)}`);
    const glAccountId = acctMap.get(sageAcctId);
    const contraAccountId = acctMap.get(sageContraId);

    if (!glAccountId || !contraAccountId) { errs++; continue; }

    try {
      // Create journal entry header
      const jeRows = await sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description,
        source, status, created_by, reference)
        VALUES (${CID}::UUID, ${'SAGE-' + je.ID}, ${entryDate}::DATE, ${je.Description || ''},
          'auto_migration', 'posted', ${USER_ID}::UUID, ${je.Reference || null})
        RETURNING id`;
      const journalId = jeRows[0].id;

      // Effect: 1 = debit main account, 2 = credit main account
      const isDebit = je.Effect === 1;
      const amount = je.Total || je.Exclusive || 0;

      // Main account line
      await sql`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
        VALUES (${journalId}::UUID, ${glAccountId}::UUID,
          ${isDebit ? amount : 0}, ${isDebit ? 0 : amount}, ${je.Description || ''})`;

      // Contra account line
      await sql`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
        VALUES (${journalId}::UUID, ${contraAccountId}::UUID,
          ${isDebit ? 0 : amount}, ${isDebit ? amount : 0}, ${je.Description || ''})`;

      ok++;
    } catch (e: any) { errs++; console.error(`  ERR JE-${je.ID}: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Journal Entries: ${ok} imported, ${errs} errors`);
}

async function importBankTransactions() {
  console.log(`\nImporting ${bankTxnData.length} bank transactions...`);
  // Find the bank account in ISAFlow (Brighttech Absa = Sage ID 1049686)
  const bankAcct = await sql`SELECT id FROM gl_accounts WHERE company_id = ${CID}::UUID AND account_code = '1049686' LIMIT 1`;
  if (bankAcct.length === 0) {
    console.log('  ERROR: Bank account 1049686 not found in gl_accounts');
    return;
  }
  const bankAccountId = bankAcct[0].id;

  let ok = 0, errs = 0;
  for (const t of bankTxnData) {
    const txnDate = t.date?.split('T')[0] || null;
    if (!txnDate) { errs++; continue; }

    try {
      await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
        description, reference, status)
        VALUES (${CID}::UUID, ${bankAccountId}::UUID, ${txnDate}::DATE, ${t.total || 0},
          ${t.desc || t.memo || ''}, ${t.ref || null},
          ${t.recon ? 'reconciled' : 'unmatched'})`;
      ok++;
    } catch (e: any) { errs++; if (errs <= 5) console.error(`  ERR: ${e.message?.slice(0, 100)}`); }
  }
  console.log(`  Bank Transactions: ${ok} imported, ${errs} errors`);
}

async function main() {
  console.log('=== Sage → ISAFlow Import: Brightsphere Technologies ===\n');
  console.log(`Data loaded: ${data.accounts.length} accounts, ${data.customers.length} customers, ${data.suppliers.length} suppliers`);
  console.log(`  ${data.arInvoices.length} AR invoices, ${data.apInvoices.length} AP invoices`);
  console.log(`  ${data.receipts.length} receipts, ${data.supplierPayments.length} supplier payments`);
  console.log(`  ${data.customerReturns.length} credit notes, ${data.journalEntries.length} journals`);
  console.log(`  ${bankTxnData.length} bank transactions`);

  // Skip already-imported: accounts, customers, suppliers, AR/AP invoices
  // Only run the new imports
  await importCustomerReceipts();
  await importSupplierPayments();
  await importJournalEntries();
  await importBankTransactions();

  // Final counts
  const counts = await sql`SELECT
    (SELECT COUNT(*) FROM gl_accounts WHERE company_id = ${CID}::UUID) as accounts,
    (SELECT COUNT(*) FROM customers WHERE company_id = ${CID}::UUID) as customers,
    (SELECT COUNT(*) FROM suppliers WHERE company_id = ${CID}::UUID) as suppliers,
    (SELECT COUNT(*) FROM customer_invoices WHERE company_id = ${CID}::UUID) as ar_invoices,
    (SELECT COUNT(*) FROM supplier_invoices WHERE company_id = ${CID}::UUID) as ap_invoices,
    (SELECT COUNT(*) FROM customer_payments WHERE company_id = ${CID}::UUID) as customer_payments,
    (SELECT COUNT(*) FROM supplier_payments WHERE company_id = ${CID}::UUID) as supplier_payments,
    (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = ${CID}::UUID) as journal_entries,
    (SELECT COUNT(*) FROM bank_transactions WHERE company_id = ${CID}::UUID) as bank_transactions`;
  console.log('\n=== Final Counts ===');
  console.log(counts[0]);
}

main().catch(console.error);
