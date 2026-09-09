/**
 * sageMigrationCommitService.ts
 *
 * Business logic for committing Sage migration data into IsaFlow.
 * Called exclusively from pages/api/admin/migration/sage-commit.ts.
 *
 * Types are defined in sageMigrationTypes.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertNoInactiveAccountLines } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { recomputeInvoiceStatus } from '@/modules/accounting/services/ar/invoiceStatusRecompute';
import type {
  Row,
  MappedCustomer,
  MappedSupplier,
  MappedARInvoice,
  MappedAPInvoice,
  CommitPayload,
  CommitSummary,
} from './sageMigrationTypes';
import { sageAccountSubtype } from './sageAccountSubtype';

export type {
  MappedAccount,
  MappedCustomer,
  MappedSupplier,
  MappedARInvoice,
  MappedAPInvoice,
  BankTx,
  CommitPayload,
  CommitSummary,
} from './sageMigrationTypes';

// ── Internal helpers ──────────────────────────────────────────────────────────

export async function upsertCustomer(companyId: string, c: MappedCustomer): Promise<string> {
  const existing = (await sql`
    SELECT id FROM customers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${c.name}) LIMIT 1
  `) as Row[];
  if (existing.length) return String(existing[0]!.id);
  const inserted = (await sql`
    INSERT INTO customers (company_id, name, email, phone, vat_number, contact_person, credit_limit, is_active)
    VALUES (
      ${companyId}::UUID, ${c.name.trim()},
      ${c.email?.trim() ?? null}, ${c.phone?.trim() ?? null},
      ${c.vatNumber?.trim() ?? null}, ${c.contactPerson?.trim() ?? null},
      ${c.creditLimit ?? 0}, TRUE
    ) RETURNING id
  `) as Row[];
  return String(inserted[0]!.id);
}

export async function upsertSupplier(companyId: string, s: MappedSupplier): Promise<string> {
  const existing = (await sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${s.name}) LIMIT 1
  `) as Row[];
  if (existing.length) return String(existing[0]!.id);
  const inserted = (await sql`
    INSERT INTO suppliers (company_id, name, email, phone, vat_number, contact_person, is_active)
    VALUES (
      ${companyId}::UUID, ${s.name.trim()},
      ${s.email?.trim() ?? null}, ${s.phone?.trim() ?? null},
      ${s.vatNumber?.trim() ?? null}, ${s.contactPerson?.trim() ?? null},
      TRUE
    ) RETURNING id
  `) as Row[];
  return String(inserted[0]!.id);
}

async function resolveCustomerId(companyId: string, name: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM customers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${name}) LIMIT 1
  `) as Row[];
  return rows.length ? String(rows[0]!.id) : null;
}

async function resolveSupplierId(companyId: string, name: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${name}) LIMIT 1
  `) as Row[];
  return rows.length ? String(rows[0]!.id) : null;
}

// The source system's already-settled portion. Clamped to [0, total] because a
// Sage credit or overpayment can make `Total - AmountDue` fall outside it, and
// `balance` is a GENERATED column (total_amount - amount_paid) that would then
// go negative.
function settledAtSource(amountPaid: number | undefined, totalAmount: number): number {
  return Math.min(Math.max(amountPaid ?? 0, 0), totalAmount);
}

// ── Public commit functions ───────────────────────────────────────────────────

export async function commitARInvoice(
  companyId: string, userId: string, inv: MappedARInvoice,
): Promise<{ invoiceId: string; created: boolean }> {
  const dupe = (await sql`
    SELECT id FROM customer_invoices
    WHERE company_id = ${companyId}::UUID AND invoice_number = ${inv.invoiceNumber} LIMIT 1
  `) as Row[];
  if (dupe.length) return { invoiceId: String(dupe[0]!.id), created: false };

  const customerId = await resolveCustomerId(companyId, inv.customerName);
  if (!customerId) throw new Error(`Customer not found: ${inv.customerName}`);

  const taxRate = inv.subtotal > 0 ? Math.round(((inv.taxAmount || 0) / inv.subtotal) * 10000) / 100 : 0;
  const amountPaid = settledAtSource(inv.amountPaid, inv.totalAmount);

  const inserted = (await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
      amount_paid, status, notes, created_by, currency_code, exchange_rate, functional_total
    ) VALUES (
      ${companyId}::UUID, ${inv.invoiceNumber}, ${customerId}::UUID, ${customerId}::UUID,
      ${inv.invoiceDate}, ${inv.dueDate ?? null},
      ${inv.subtotal}, ${taxRate}, ${inv.taxAmount}, ${inv.totalAmount},
      ${amountPaid}, 'approved', ${inv.reference ?? null}, ${userId}, 'ZAR', 1.0, ${inv.totalAmount}
    ) RETURNING id
  `) as Row[];
  const invoiceId = String(inserted[0]!.id);

  await sql`
    INSERT INTO customer_invoice_items
      (invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code)
    VALUES
      (${invoiceId}::UUID, ${inv.reference ?? `Invoice ${inv.invoiceNumber}`},
       ${inv.subtotal}, 1, ${inv.subtotal}, ${taxRate}, 'ZAR')
  `;
  // historicalImport: a migrated invoice belongs in its ORIGINAL period, which
  // is usually closed. Without this the canonical path would refuse it, and
  // refusing is right everywhere except here.
  await postCustomerInvoiceToGL(companyId, invoiceId, userId, { historicalImport: true });
  // 'approved' above is only the open-invoice default; the canonical helper
  // narrows it to partially_paid/paid (and sets paid_at) from amount_paid.
  if (amountPaid > 0) await recomputeInvoiceStatus(companyId, 'customer', invoiceId);
  return { invoiceId, created: true };
}

export async function commitAPInvoice(
  companyId: string, userId: string, inv: MappedAPInvoice,
): Promise<{ invoiceId: string; created: boolean }> {
  const dupe = (await sql`
    SELECT id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND invoice_number = ${inv.invoiceNumber} LIMIT 1
  `) as Row[];
  if (dupe.length) return { invoiceId: String(dupe[0]!.id), created: false };

  const supplierId = await resolveSupplierId(companyId, inv.supplierName);
  if (!supplierId) throw new Error(`Supplier not found: ${inv.supplierName}`);

  const taxRate = inv.subtotal > 0 ? Math.round(((inv.taxAmount || 0) / inv.subtotal) * 10000) / 100 : 0;
  const amountPaid = settledAtSource(inv.amountPaid, inv.totalAmount);

  const created = await createSupplierInvoice(companyId, {
    supplierId, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate ?? undefined, taxRate, reference: inv.reference,
    items: [{ description: inv.reference ?? `Invoice ${inv.invoiceNumber}`, quantity: 1, unitPrice: inv.subtotal, taxRate }],
  }, userId);

  // Post JE directly — bypasses workflow helper that blocks backdated periods.
  // postJournalEntry is the canonical posting path; this diverges from it for
  // that ONE reason. A migrated supplier invoice belongs in its original
  // period, which is usually closed, so the period guard cannot apply. Every
  // other guard still does — see assertNoInactiveAccountLines below, called
  // before the status UPDATE so a refusal writes nothing.
  const [apAccount, vatAccount, expenseAccount] = await Promise.all([
    getSystemAccount('payable', companyId),
    getSystemAccount('vat_input', companyId),
    getSystemAccount('default_expense', companyId),
  ]);

  const lines = [{ glAccountId: expenseAccount.id, debit: inv.subtotal, credit: 0, description: inv.reference ?? `Invoice ${inv.invoiceNumber}` }];
  if ((inv.taxAmount || 0) > 0) lines.push({ glAccountId: vatAccount.id, debit: inv.taxAmount, credit: 0, description: `VAT on ${inv.invoiceNumber}` });
  lines.push({ glAccountId: apAccount.id, debit: 0, credit: inv.totalAmount, description: `AP: ${inv.invoiceNumber}` });

  const je = await createJournalEntry(companyId, {
    entryDate: inv.invoiceDate, description: `Supplier invoice ${inv.invoiceNumber}`,
    source: 'auto_supplier_invoice', lines,
  }, userId);

  await assertNoInactiveAccountLines(companyId, je.id);
  await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = ${je.id}::UUID AND company_id = ${companyId}::UUID`;
  await sql`UPDATE supplier_invoices SET status = 'approved', approved_at = NOW(), amount_paid = ${amountPaid}, gl_journal_entry_id = ${je.id}::UUID WHERE id = ${created.id}::UUID AND company_id = ${companyId}::UUID`;
  // Same as AR: 'approved' is the open default, narrowed from amount_paid.
  if (amountPaid > 0) await recomputeInvoiceStatus(companyId, 'supplier', created.id);
  return { invoiceId: created.id, created: true };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function commitSageMigration(payload: CommitPayload): Promise<CommitSummary> {
  const { companyId, userId, pulled } = payload;

  const summary: CommitSummary = {
    accounts:         { created: 0, skipped: 0, failed: [] },
    customers:        { created: 0, skipped: 0, failed: [] },
    suppliers:        { created: 0, skipped: 0, failed: [] },
    arInvoices:       { created: 0, skipped: 0, failed: [] },
    apInvoices:       { created: 0, skipped: 0, failed: [] },
    bankTransactions: { created: 0, skipped: 0, failed: [] },
  };

  // Per-record commits rollback to the savepoint on failure; the inner catch in
  // each loop body has already pushed a structured entry into `summary.*.failed`
  // and rethrown to trigger the rollback. Log once at this boundary so the
  // failure isn't completely silent in production.
  const sp = (name: string, fn: () => Promise<void>) =>
    withSavepoint(name, fn).catch((err: unknown) => {
      log.warn('sage commit: savepoint rolled back', {
        savepoint: name,
        error: err instanceof Error ? err.message : String(err),
      }, 'sage-migration');
    });

  // Chart of Accounts
  let ai = 0;
  for (const a of pulled.accounts?.records ?? []) {
    await sp(`acc_${ai++}`, async () => {
      try {
        const ins = (await sql`
          INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, description, is_system_account, is_active, level, display_order)
          VALUES (${companyId}::UUID, ${a.accountCode}, ${a.accountName}, ${a.accountType}, ${sageAccountSubtype(a.accountType, a.category, a.accountName)}, ${a.normalBalance}, ${a.description ?? null}, ${a.isSystem ?? false}, ${a.isActive ?? true}, 0, 0)
          ON CONFLICT (company_id, account_code) DO NOTHING RETURNING id
        `) as Row[];
        if (ins.length) summary.accounts.created += 1; else summary.accounts.skipped += 1;
      } catch (err) {
        summary.accounts.failed.push(`${a.accountCode} ${a.accountName}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // Customers
  let i = 0;
  for (const c of pulled.customers?.records ?? []) {
    await sp(`cust_${i++}`, async () => {
      try {
        const existed = (await sql`SELECT 1 FROM customers WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${c.name}) LIMIT 1`) as Row[];
        await upsertCustomer(companyId, c);
        if (existed.length) summary.customers.skipped += 1; else summary.customers.created += 1;
      } catch (err) {
        summary.customers.failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // Suppliers
  i = 0;
  for (const s of pulled.suppliers?.records ?? []) {
    await sp(`supp_${i++}`, async () => {
      try {
        const existed = (await sql`SELECT 1 FROM suppliers WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${s.name}) LIMIT 1`) as Row[];
        await upsertSupplier(companyId, s);
        if (existed.length) summary.suppliers.skipped += 1; else summary.suppliers.created += 1;
      } catch (err) {
        summary.suppliers.failed.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // AR Invoices
  i = 0;
  for (const inv of pulled.arInvoices?.records ?? []) {
    await sp(`ar_${i++}`, async () => {
      try {
        const r = await commitARInvoice(companyId, userId, inv);
        if (r.created) summary.arInvoices.created += 1; else summary.arInvoices.skipped += 1;
      } catch (err) {
        summary.arInvoices.failed.push(`${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // AP Invoices
  i = 0;
  for (const inv of pulled.apInvoices?.records ?? []) {
    await sp(`ap_${i++}`, async () => {
      try {
        const r = await commitAPInvoice(companyId, userId, inv);
        if (r.created) summary.apInvoices.created += 1; else summary.apInvoices.skipped += 1;
      } catch (err) {
        summary.apInvoices.failed.push(`${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  // Bank Transactions (chunked)
  const btx = pulled.bankTransactions;
  if (btx?.records?.length) {
    const BATCH = 500;
    const accountId = btx.bankAccountId;
    const ok = (await sql`SELECT 1 FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID AND account_subtype = 'bank' LIMIT 1`) as Row[];
    if (!ok.length) {
      summary.bankTransactions.failed.push(`Bank account ${accountId} not found for company`);
    } else {
      for (let start = 0; start < btx.records.length; start += BATCH) {
        const chunk = btx.records.slice(start, start + BATCH);
        await withSavepoint(`btx_${start}`, async () => {
          for (const tx of chunk) {
            try {
              const dup = (await sql`SELECT 1 FROM bank_transactions WHERE bank_account_id = ${accountId}::UUID AND transaction_date = ${tx.date}::DATE AND amount = ${tx.amount} AND COALESCE(description, '') = ${tx.description ?? ''} LIMIT 1`) as Row[];
              if (dup.length) { summary.bankTransactions.skipped += 1; continue; }
              await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, reference, status) VALUES (${companyId}::UUID, ${accountId}::UUID, ${tx.date}::DATE, ${tx.amount}, ${tx.description ?? null}, ${tx.reference ?? null}, 'imported')`;
              summary.bankTransactions.created += 1;
            } catch (err) {
              summary.bankTransactions.failed.push(`${tx.date} ${tx.amount}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }).catch(() => { /* chunk savepoint — per-record errors already captured */ });
      }
    }
  }

  log.info('Sage commit complete', { companyId, summary }, 'migration');
  return summary;
}
