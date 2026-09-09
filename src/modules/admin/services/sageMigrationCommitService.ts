/**
 * sageMigrationCommitService.ts
 *
 * Per-entity commit functions for a Sage migration. The orchestrator that
 * calls them lives in sageMigrationOrchestrator.ts; both are reached from
 * pages/api/admin/migration/sage-commit.ts.
 *
 * Types are defined in sageMigrationTypes.ts.
 */

import { sql } from '@/lib/neon';
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
  CommitOutcome,
} from './sageMigrationTypes';

export type {
  MappedAccount,
  MappedCustomer,
  MappedSupplier,
  MappedARInvoice,
  MappedAPInvoice,
  BankTx,
  CommitOutcome,
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

/**
 * The source system's already-settled portion, made safe for the database.
 *
 * `balance` is a GENERATED column (`total_amount - amount_paid`) on both
 * `customer_invoices` and `supplier_invoices`, so whatever lands here lands in
 * every aggregate that sums a balance. Two hazards, both silent in Postgres:
 *
 * - NON-FINITE. `Total - AmountDue` is NaN whenever the Sage document carries
 *   no numeric `AmountDue`, and neither the pull (`sage-pull-server.ts` casts
 *   the response `as any`) nor the commit route (`sage-commit.ts` casts
 *   `req.body`) validates it. `numeric` ACCEPTS NaN, and one NaN row turns the
 *   whole company's ar/apSubLedgerCheck sum into NaN. Refused, not clamped.
 * - OUT OF RANGE. A Sage credit or overpayment puts the figure outside
 *   [0, total], which would store a negative balance.
 *
 * `totalAmount` must be the total STORED on the row, not the source's total:
 * `createSupplierInvoice` re-derives its own from a 2 dp tax rate, so the two
 * differ by cents on any bill whose blended VAT rate is not exact.
 *
 * Every rejection and every clamp is returned as a warning as well as logged —
 * a discarded overpayment is a customer credit that leaves no other trace.
 */
function settledAtSource(
  invoiceNumber: string, amountPaid: number | undefined, totalAmount: number,
): { amountPaid: number; warning?: string } {
  const raw = Number(amountPaid ?? 0);
  if (!Number.isFinite(raw)) {
    const warning = `${invoiceNumber}: source paid amount is not a finite number (${String(amountPaid)}) — imported as unpaid`;
    log.warn('sage commit: non-finite source amountPaid, importing as unpaid', { invoiceNumber, amountPaid }, 'sage-migration');
    return { amountPaid: 0, warning };
  }
  if (raw < 0) {
    const warning = `${invoiceNumber}: source paid amount is negative (${raw}) — imported as unpaid`;
    log.warn('sage commit: negative source amountPaid, importing as unpaid', { invoiceNumber, amountPaid: raw }, 'sage-migration');
    return { amountPaid: 0, warning };
  }
  if (raw > totalAmount) {
    // Below a cent this is arithmetic dust, not a credit: `createSupplierInvoice`
    // sums `subtotal + totalTax` without re-rounding, so a stored total can be
    // 1345.6699999999998. Warning on that would bury the real overpayments this
    // list exists to surface, and would read "0 of credit was NOT imported".
    const excess = Math.round((raw - totalAmount) * 100) / 100;
    if (excess < 0.01) return { amountPaid: totalAmount };
    const warning = `${invoiceNumber}: the source's settled amount exceeds the invoice total of ${totalAmount} by ${excess} — that much credit was NOT imported`;
    log.warn('sage commit: source amountPaid exceeds the invoice total; excess discarded', { invoiceNumber, amountPaid: raw, totalAmount, excess }, 'sage-migration');
    return { amountPaid: totalAmount, warning };
  }
  return { amountPaid: raw };
}

// ── Public commit functions ───────────────────────────────────────────────────

export async function commitARInvoice(
  companyId: string, userId: string, inv: MappedARInvoice,
): Promise<CommitOutcome> {
  const dupe = (await sql`
    SELECT id FROM customer_invoices
    WHERE company_id = ${companyId}::UUID AND invoice_number = ${inv.invoiceNumber} LIMIT 1
  `) as Row[];
  if (dupe.length) return { invoiceId: String(dupe[0]!.id), created: false };

  const customerId = await resolveCustomerId(companyId, inv.customerName);
  if (!customerId) throw new Error(`Customer not found: ${inv.customerName}`);

  const taxRate = inv.subtotal > 0 ? Math.round(((inv.taxAmount || 0) / inv.subtotal) * 10000) / 100 : 0;
  const settled = settledAtSource(inv.invoiceNumber, inv.amountPaid, inv.totalAmount);
  const amountPaid = settled.amountPaid;

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
  return { invoiceId, created: true, warning: settled.warning };
}

export async function commitAPInvoice(
  companyId: string, userId: string, inv: MappedAPInvoice,
): Promise<CommitOutcome> {
  const dupe = (await sql`
    SELECT id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND invoice_number = ${inv.invoiceNumber} LIMIT 1
  `) as Row[];
  if (dupe.length) return { invoiceId: String(dupe[0]!.id), created: false };

  const supplierId = await resolveSupplierId(companyId, inv.supplierName);
  if (!supplierId) throw new Error(`Supplier not found: ${inv.supplierName}`);

  const taxRate = inv.subtotal > 0 ? Math.round(((inv.taxAmount || 0) / inv.subtotal) * 10000) / 100 : 0;

  const created = await createSupplierInvoice(companyId, {
    supplierId, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate ?? undefined, taxRate, reference: inv.reference,
    items: [{ description: inv.reference ?? `Invoice ${inv.invoiceNumber}`, quantity: 1, unitPrice: inv.subtotal, taxRate }],
  }, userId);

  // What Sage says is still OUTSTANDING is the figure to preserve, not what it
  // says was paid. createSupplierInvoice recomputes the total from the 2 dp
  // `taxRate` above, so any bill whose blended VAT rate is not exact stores a
  // total that differs from Sage's by cents — in EITHER direction. Carrying the
  // source's paid amount across would then store a negative balance (stored
  // total below Sage's) or strand a fully settled bill at `partially_paid` with
  // a residual that never clears (stored total above Sage's, the case the clamp
  // cannot see because it only binds upwards). Re-deriving from the outstanding
  // amount makes the row agree with the source by construction: AmountDue 0
  // settles the bill exactly, whatever the recomputed total came to.
  const dueAtSource = Number(inv.totalAmount) - Number(inv.amountPaid ?? 0);
  const paidAgainstStored = Math.round((created.totalAmount - dueAtSource) * 100) / 100;
  const settled = settledAtSource(inv.invoiceNumber, paidAgainstStored, created.totalAmount);
  const amountPaid = settled.amountPaid;

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
  return { invoiceId: created.id, created: true, warning: settled.warning };
}
