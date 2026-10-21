/**
 * The reviewer sandbox's fictional books, written through the app's own
 * services (never raw INSERTs into ledger tables), so every ledger invariant
 * and trigger holds. Each step looks its natural key up first, so a re-run of
 * --apply adds nothing.
 *
 * Every service call runs inside withAlsTransaction (the request context the
 * services' locks expect), on the same DATABASE_URL connection the seed
 * scripts use. Payroll is NOT seeded here (see the PR's "Left out").
 */
import type { TaggedSql } from '../_pg';
import { withAlsTransaction } from '../../src/lib/alsTransaction';
import { createCustomer } from '../../src/modules/accounting/services/core/customerWriteService';
import { createSupplier } from '../../src/modules/accounting/services/core/supplierWriteService';
import { createDraftCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCustomerPayment } from '../../src/modules/accounting/services/ar/customerPaymentService';
import { confirmCustomerPayment } from '../../src/modules/accounting/services/ar/customerPaymentAllocationService';
import { createSupplierInvoice } from '../../src/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostService';
import { createAccount } from '../../src/modules/accounting/services/gl/chartOfAccountsService';
import { importParsedTransactions } from '../../src/modules/accounting/services/bank/bankImportService';
import {
  DEMO_BANK_ACCOUNT_NAME,
  DEMO_BANK_LINES,
  DEMO_CUSTOMERS,
  DEMO_CUSTOMER_INVOICES,
  DEMO_JOURNALS,
  DEMO_SUPPLIERS,
  DEMO_SUPPLIER_INVOICES,
  SANDBOX_COMPANY,
} from './reviewerSandboxData';
import { isoDaysAgo } from './reviewerSandboxGuards';

const COMPANY_ID = SANDBOX_COMPANY.id;
const VAT_RATE = 15;
/** Next to the taxonomy's 1110 "Bank - Primary", under 1100 Current Assets. */
const DEMO_BANK_CODE = '1115';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function seedBooks(sql: TaggedSql, userId: string, today: Date, say: (line: string) => void): Promise<void> {
  const inCtx = <T>(fn: () => Promise<T>): Promise<T> => withAlsTransaction({ userId, companyId: COMPANY_ID }, fn);
  const findAccount = async (code: string): Promise<string | null> => {
    const rows = await sql<{ id: string }>`
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY_ID}::uuid AND account_code = ${code} LIMIT 1`;
    return rows[0]?.id ?? null;
  };
  const accountId = async (code: string): Promise<string> => {
    const id = await findAccount(code);
    if (!id) throw new Error(`Account ${code} is missing from the sandbox chart`);
    return id;
  };

  // Bank account: a GL account with a bank subtype, which is how the app models one.
  let bankId = await findAccount(DEMO_BANK_CODE);
  if (!bankId) {
    const parentAccountId = await accountId('1100');
    const acc = await inCtx(() => createAccount(COMPANY_ID, {
      accountCode: DEMO_BANK_CODE, accountName: DEMO_BANK_ACCOUNT_NAME, accountType: 'asset',
      accountSubtype: 'bank', parentAccountId, normalBalance: 'debit',
    }));
    bankId = acc.id;
    say(`created bank account ${DEMO_BANK_ACCOUNT_NAME}`);
  }
  const bankAccountId: string = bankId;

  const customerIds = new Map<string, string>();
  for (const c of DEMO_CUSTOMERS) {
    const found = await sql<{ id: string }>`
      SELECT id FROM customers WHERE company_id = ${COMPANY_ID}::uuid AND notes = ${c.code} LIMIT 1`;
    const id = found[0]?.id ?? String((await inCtx(() => createCustomer(COMPANY_ID, {
      name: c.name, email: c.email, notes: c.code, paymentTerms: 30, isActive: true,
    }))).id);
    customerIds.set(c.code, id);
  }
  const supplierIds = new Map<string, string>();
  for (const s of DEMO_SUPPLIERS) {
    const found = await sql<{ id: string }>`
      SELECT id FROM suppliers WHERE company_id = ${COMPANY_ID}::uuid AND notes = ${s.code} LIMIT 1`;
    const id = found[0]?.id ?? String((await inCtx(() => createSupplier(COMPANY_ID, {
      name: s.name, email: s.email, notes: s.code, paymentTerms: 30, isActive: true,
    }, userId))).id);
    supplierIds.set(s.code, id);
  }
  say(`customers ${customerIds.size}, suppliers ${supplierIds.size}`);

  for (const inv of DEMO_CUSTOMER_INVOICES) {
    const found = await sql<{ id: string }>`
      SELECT id FROM customer_invoices WHERE company_id = ${COMPANY_ID}::uuid AND notes = ${inv.reference} LIMIT 1`;
    if (found[0]) continue;
    const clientId = customerIds.get(inv.customerCode)!;
    const draft = await inCtx(() => createDraftCustomerInvoice(COMPANY_ID, userId, {
      clientId, invoiceDate: isoDaysAgo(today, inv.issuedDaysAgo), dueDate: isoDaysAgo(today, inv.issuedDaysAgo - 30),
      taxRate: VAT_RATE, notes: inv.reference,
      items: [{ description: inv.description, unitPrice: inv.amountExclVat, quantity: 1 }],
    }));
    await inCtx(() => approveCustomerInvoice(COMPANY_ID, draft.id, userId));
    if (inv.state === 'paid') {
      const total = round2(inv.amountExclVat * (1 + VAT_RATE / 100));
      const payment = await inCtx(() => createCustomerPayment(COMPANY_ID, {
        clientId, paymentDate: isoDaysAgo(today, inv.issuedDaysAgo - 10), totalAmount: total,
        paymentMethod: 'eft', bankAccountId, bankReference: `RCPT ${inv.reference}`,
        description: `Demo receipt for ${inv.reference}`, allocations: [{ invoiceId: draft.id, amount: total }],
      }, userId));
      await inCtx(() => confirmCustomerPayment(COMPANY_ID, payment.id, userId));
    }
    say(`invoice ${inv.reference} (${inv.state})`);
  }

  for (const bill of DEMO_SUPPLIER_INVOICES) {
    const found = await sql<{ id: string }>`
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY_ID}::uuid AND invoice_number = ${bill.reference} LIMIT 1`;
    if (found[0]) continue;
    const created = await inCtx(() => createSupplierInvoice(COMPANY_ID, {
      invoiceNumber: bill.reference, supplierId: supplierIds.get(bill.supplierCode)!,
      invoiceDate: isoDaysAgo(today, bill.issuedDaysAgo), taxRate: VAT_RATE,
      items: [{ description: bill.description, quantity: 1, unitPrice: bill.amountExclVat, taxRate: VAT_RATE }],
    }, userId));
    // Approval posts the Expense / VAT / AP journal.
    await inCtx(() => approveSupplierInvoice(COMPANY_ID, created.id, userId));
    say(`supplier invoice ${bill.reference}`);
  }

  for (const j of DEMO_JOURNALS) {
    const found = await sql<{ id: string }>`
      SELECT id FROM gl_journal_entries WHERE company_id = ${COMPANY_ID}::uuid AND reference = ${j.reference} LIMIT 1`;
    if (found[0]) continue;
    const lines = [];
    for (const l of j.lines) lines.push({ glAccountId: await accountId(l.accountCode), debit: l.debit, credit: l.credit });
    // createJournalEntry opens its own withAlsTransaction.
    const entry = await createJournalEntry(COMPANY_ID, {
      entryDate: isoDaysAgo(today, j.daysAgo), description: j.description, reference: j.reference, lines,
    }, userId);
    await inCtx(() => postJournalEntry(COMPANY_ID, entry.id, userId));
    say(`journal ${j.reference}`);
  }

  const imported = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bank_transactions
    WHERE company_id = ${COMPANY_ID}::uuid AND bank_account_id = ${bankAccountId}::uuid`;
  if ((imported[0]?.n ?? 0) === 0) {
    const transactions = DEMO_BANK_LINES.map((b) => ({
      transactionDate: isoDaysAgo(today, b.daysAgo), amount: b.amount, description: b.description, reference: b.reference,
    }));
    const result = await inCtx(() => importParsedTransactions(
      COMPANY_ID, { transactions, errors: [], bankFormat: 'reviewer-sandbox' }, bankAccountId, isoDaysAgo(today, 0),
      { importedBy: userId, sourceFilename: 'reviewer-sandbox-demo.csv' },
    ));
    say(`bank lines imported: ${result.transactionCount}`);
  }
}
