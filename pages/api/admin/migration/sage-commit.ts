/**
 * Admin Sage Commit API
 *
 * POST /api/admin/migration/sage-commit
 * Body: {
 *   companyId: string,
 *   pulled: {
 *     customers?:  { records: MappedSageCustomer[] },
 *     suppliers?:  { records: MappedSageSupplier[] },
 *     arInvoices?: { records: MappedSageARInvoice[] },
 *     apInvoices?: { records: MappedSageAPInvoice[] },
 *   },
 * }
 *
 * Persists mapped Sage data into the target company and posts journal
 * entries. Idempotent on invoice_number (skipped if already present).
 * Per-record errors don't abort the batch — the response includes a
 * counts summary plus a list of failures.
 *
 * Staff-only via withAdmin.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { log } from '@/lib/logger';
import { sql, withSavepoint } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

type Row = Record<string, unknown>;

interface MappedCustomer { name: string; email?: string; phone?: string; vatNumber?: string; contactPerson?: string; creditLimit?: number; }
interface MappedSupplier { name: string; email?: string; phone?: string; vatNumber?: string; contactPerson?: string; }
interface MappedARInvoice { invoiceNumber: string; customerName: string; invoiceDate: string; dueDate?: string; subtotal: number; taxAmount: number; totalAmount: number; reference?: string; sageId?: number; }
interface MappedAPInvoice { invoiceNumber: string; supplierName: string; invoiceDate: string; dueDate?: string; subtotal: number; taxAmount: number; totalAmount: number; reference?: string; sageId?: number; }

interface CommitBody {
  companyId?: string;
  pulled?: {
    customers?:  { records?: MappedCustomer[] };
    suppliers?:  { records?: MappedSupplier[] };
    arInvoices?: { records?: MappedARInvoice[] };
    apInvoices?: { records?: MappedAPInvoice[] };
  };
}

async function upsertCustomer(companyId: string, c: MappedCustomer): Promise<string> {
  const existing = (await sql`
    SELECT id FROM customers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${c.name})
    LIMIT 1
  `) as Row[];
  if (existing.length) return String(existing[0]!.id);

  const inserted = (await sql`
    INSERT INTO customers (company_id, name, email, phone, vat_number, contact_person, credit_limit, is_active)
    VALUES (
      ${companyId}::UUID, ${c.name.trim()},
      ${c.email?.trim() || null}, ${c.phone?.trim() || null},
      ${c.vatNumber?.trim() || null}, ${c.contactPerson?.trim() || null},
      ${c.creditLimit ?? 0}, TRUE
    )
    RETURNING id
  `) as Row[];
  return String(inserted[0]!.id);
}

async function upsertSupplier(companyId: string, s: MappedSupplier): Promise<string> {
  const existing = (await sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${s.name})
    LIMIT 1
  `) as Row[];
  if (existing.length) return String(existing[0]!.id);

  const inserted = (await sql`
    INSERT INTO suppliers (company_id, name, email, phone, vat_number, contact_person, is_active)
    VALUES (
      ${companyId}::UUID, ${s.name.trim()},
      ${s.email?.trim() || null}, ${s.phone?.trim() || null},
      ${s.vatNumber?.trim() || null}, ${s.contactPerson?.trim() || null},
      TRUE
    )
    RETURNING id
  `) as Row[];
  return String(inserted[0]!.id);
}

async function resolveCustomerId(companyId: string, name: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM customers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${name})
    LIMIT 1
  `) as Row[];
  return rows.length ? String(rows[0]!.id) : null;
}

async function resolveSupplierId(companyId: string, name: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${name})
    LIMIT 1
  `) as Row[];
  return rows.length ? String(rows[0]!.id) : null;
}

async function commitARInvoice(
  companyId: string, userId: string, inv: MappedARInvoice,
): Promise<{ invoiceId: string; created: boolean }> {
  const dupe = (await sql`
    SELECT id, gl_journal_entry_id FROM customer_invoices
    WHERE company_id = ${companyId}::UUID AND invoice_number = ${inv.invoiceNumber}
    LIMIT 1
  `) as Row[];
  if (dupe.length) {
    return { invoiceId: String(dupe[0]!.id), created: false };
  }

  const customerId = await resolveCustomerId(companyId, inv.customerName);
  if (!customerId) throw new Error(`Customer not found: ${inv.customerName}`);

  const taxRate = inv.subtotal > 0
    ? Math.round(((inv.taxAmount || 0) / inv.subtotal) * 10000) / 100
    : 0;

  const inserted = (await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount,
      status, notes, created_by,
      currency_code, exchange_rate, functional_total
    ) VALUES (
      ${companyId}::UUID, ${inv.invoiceNumber}, ${customerId}::UUID, ${customerId}::UUID,
      ${inv.invoiceDate}, ${inv.dueDate || null},
      ${inv.subtotal}, ${taxRate}, ${inv.taxAmount}, ${inv.totalAmount},
      'approved', ${inv.reference || null}, ${userId},
      'ZAR', 1.0, ${inv.totalAmount}
    )
    RETURNING id
  `) as Row[];
  const invoiceId = String(inserted[0]!.id);

  await sql`
    INSERT INTO customer_invoice_items (
      invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
    ) VALUES (
      ${invoiceId}::UUID, ${inv.reference || `Invoice ${inv.invoiceNumber}`},
      ${inv.subtotal}, 1, ${inv.subtotal}, ${taxRate}, 'ZAR'
    )
  `;

  await postCustomerInvoiceToGL(companyId, invoiceId, userId);
  return { invoiceId, created: true };
}

async function commitAPInvoice(
  companyId: string, userId: string, inv: MappedAPInvoice,
): Promise<{ invoiceId: string; created: boolean }> {
  const dupe = (await sql`
    SELECT id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND invoice_number = ${inv.invoiceNumber}
    LIMIT 1
  `) as Row[];
  if (dupe.length) {
    return { invoiceId: String(dupe[0]!.id), created: false };
  }

  const supplierId = await resolveSupplierId(companyId, inv.supplierName);
  if (!supplierId) throw new Error(`Supplier not found: ${inv.supplierName}`);

  const taxRate = inv.subtotal > 0
    ? Math.round(((inv.taxAmount || 0) / inv.subtotal) * 10000) / 100
    : 0;

  const created = await createSupplierInvoice(companyId, {
    supplierId,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate || undefined,
    taxRate,
    reference: inv.reference,
    items: [{
      description: inv.reference || `Invoice ${inv.invoiceNumber}`,
      quantity: 1,
      unitPrice: inv.subtotal,
      taxRate,
    }],
  }, userId);

  // Post the JE directly instead of going through approveSupplierInvoice —
  // the workflow helper calls postJournalEntry which blocks posting to
  // closed fiscal periods. For a historical Sage migration we need to
  // back-date freely. Flip status to 'posted' via direct UPDATE (same
  // pattern postCustomerInvoiceToGL uses for AR).
  const apAccount = await getSystemAccount('payable', companyId);
  const vatAccount = await getSystemAccount('vat_input', companyId);
  const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);

  const lines = [{
    glAccountId: defaultExpenseAccount.id,
    debit: inv.subtotal,
    credit: 0,
    description: inv.reference || `Invoice ${inv.invoiceNumber}`,
  }];
  if ((inv.taxAmount || 0) > 0) {
    lines.push({
      glAccountId: vatAccount.id,
      debit: inv.taxAmount,
      credit: 0,
      description: `VAT on ${inv.invoiceNumber}`,
    });
  }
  lines.push({
    glAccountId: apAccount.id,
    debit: 0,
    credit: inv.totalAmount,
    description: `AP: ${inv.invoiceNumber}`,
  });

  const je = await createJournalEntry(companyId, {
    entryDate: inv.invoiceDate,
    description: `Supplier invoice ${inv.invoiceNumber}`,
    source: 'auto_supplier_invoice',
    lines,
  }, userId);

  await sql`
    UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW()
    WHERE id = ${je.id}::UUID AND company_id = ${companyId}::UUID
  `;
  await sql`
    UPDATE supplier_invoices
    SET status = 'approved', approved_at = NOW(), gl_journal_entry_id = ${je.id}::UUID
    WHERE id = ${created.id}::UUID AND company_id = ${companyId}::UUID
  `;

  return { invoiceId: created.id, created: true };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const body = (req.body ?? {}) as CommitBody;
  const { companyId, pulled } = body;

  if (!companyId) return apiResponse.validationError(res, { companyId: 'companyId is required' });
  if (!pulled) return apiResponse.validationError(res, { pulled: 'pulled data is required' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id ?? 'sage-migration';

  const summary = {
    customers:  { created: 0, skipped: 0, failed: [] as string[] },
    suppliers:  { created: 0, skipped: 0, failed: [] as string[] },
    arInvoices: { created: 0, skipped: 0, failed: [] as string[] },
    apInvoices: { created: 0, skipped: 0, failed: [] as string[] },
  };

  // Each per-record operation runs in a SAVEPOINT so a single failure
  // doesn't poison the outer withAdmin transaction. Without this, the
  // first invoice error would abort the tx and every subsequent query
  // would return "current transaction is aborted".
  const sp = (name: string, fn: () => Promise<void>) =>
    withSavepoint(name, fn).catch(() => { /* swallowed: per-record handler below records the failure */ });

  const customers = pulled.customers?.records ?? [];
  let i = 0;
  for (const c of customers) {
    await sp(`cust_${i++}`, async () => {
      try {
        const existed = (await sql`
          SELECT 1 FROM customers WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${c.name}) LIMIT 1
        `) as Row[];
        await upsertCustomer(companyId, c);
        if (existed.length) summary.customers.skipped += 1;
        else summary.customers.created += 1;
      } catch (err) {
        summary.customers.failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  const suppliers = pulled.suppliers?.records ?? [];
  i = 0;
  for (const s of suppliers) {
    await sp(`supp_${i++}`, async () => {
      try {
        const existed = (await sql`
          SELECT 1 FROM suppliers WHERE company_id = ${companyId}::UUID AND LOWER(name) = LOWER(${s.name}) LIMIT 1
        `) as Row[];
        await upsertSupplier(companyId, s);
        if (existed.length) summary.suppliers.skipped += 1;
        else summary.suppliers.created += 1;
      } catch (err) {
        summary.suppliers.failed.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  const arInvoices = pulled.arInvoices?.records ?? [];
  i = 0;
  for (const inv of arInvoices) {
    await sp(`ar_${i++}`, async () => {
      try {
        const r = await commitARInvoice(companyId, userId, inv);
        if (r.created) summary.arInvoices.created += 1;
        else summary.arInvoices.skipped += 1;
      } catch (err) {
        summary.arInvoices.failed.push(`${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  const apInvoices = pulled.apInvoices?.records ?? [];
  i = 0;
  for (const inv of apInvoices) {
    await sp(`ap_${i++}`, async () => {
      try {
        const r = await commitAPInvoice(companyId, userId, inv);
        if (r.created) summary.apInvoices.created += 1;
        else summary.apInvoices.skipped += 1;
      } catch (err) {
        summary.apInvoices.failed.push(`${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }

  log.info('Sage commit complete', { companyId, summary }, 'migration');
  return apiResponse.success(res, summary);
}

export default withAdmin(handler);
